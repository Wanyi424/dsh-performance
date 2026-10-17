import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Analysis, Hot, Owner } from './contracts';
import { pathKey, pluginOf } from './metrics';
import type { PluginDir } from './plugins';

interface CallFrame { functionName: string; url: string; lineNumber: number }
export interface CpuProfile { nodes: { id: number; callFrame: CallFrame; children?: number[] }[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }
export interface HeapNode { callFrame: CallFrame; selfSize: number; children: HeapNode[] }

/** Who a frame's code belongs to: a plugin, a DSH package (or the Node runtime), or a package of neither. */
type Frame = { kind: 'plugin'; id: string; dir: string } | { kind: 'core'; module: string } | { kind: 'other'; module: string } | null;
/** What a sample or allocation is charged to: the nearest plugin frame on its stack, else the nearest DSH or other package. */
interface Charge { plugin?: { id: string; hot: string }; core?: string; other?: string }

function packageOf(path: string) {
  const parts = path.split(/[\\/]/), at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return null;
  return parts[at + 1].startsWith('@') ? `${parts[at + 1]}/${parts[at + 2] ?? ''}` : parts[at + 1];
}

/**
 * Attributes a main-thread CPU profile and a sampling heap profile to plugins. A sample counts for the nearest plugin frame on
 * its stack, so DSH code that a plugin calls synchronously is that plugin's time; with no plugin on the stack it is DSH's,
 * grouped by package. Work DSH does later on a plugin's behalf (after an await) carries no plugin frame and stays DSH's.
 */
export function attribute(profile: CpuProfile, heap: HeapNode | null, plugins: readonly PluginDir[], root: string): Analysis {
  const frames = new Map<string, Frame>(), rootKey = pathKey(root) + sep;
  const frameOf = (url: string): Frame => {
    let known = frames.get(url);
    if (known !== undefined) return known;
    if (!url) known = null;
    else if (url.startsWith('node:')) known = { kind: 'core', module: 'Node.js' };
    else {
      let path = url;
      try { if (url.startsWith('file:')) path = fileURLToPath(url.split(/[?#]/)[0]); } catch { /* keep the raw URL */ }
      const plugin = pluginOf(path, plugins), module = packageOf(path) ?? path.split(/[\\/]/).at(-1) ?? path;
      if (plugin) { const p = plugins.find(x => x.id === plugin)!; known = { kind: 'plugin', id: plugin, dir: p.dir }; }
      else known = pathKey(path).startsWith(rootKey) ? { kind: 'core', module } : { kind: 'other', module };
      // A frame from DSH's own folder outside node_modules (its entry files) is still DSH.
      if (known.kind === 'core' && !packageOf(path)) known = { kind: 'core', module: 'DeepSeek Harness' };
    }
    frames.set(url, known);
    return known;
  };
  const hotName = (frame: CallFrame, dir: string) => {
    let path = frame.url;
    try { if (path.startsWith('file:')) path = fileURLToPath(path.split(/[?#]/)[0]); } catch { /* keep */ }
    return `${frame.functionName || '（匿名函数）'}\u0000${relative(dir, path).split(sep).join('/')}:${frame.lineNumber + 1}`;
  };
  const charge = (frame: CallFrame, parent: Charge): Charge => {
    const f = frameOf(frame.url);
    if (f?.kind === 'plugin') return { plugin: { id: f.id, hot: hotName(frame, f.dir) }, core: parent.core, other: parent.other };
    if (f?.kind === 'core') return { ...parent, core: parent.plugin ? parent.core : f.module };
    if (f?.kind === 'other') return { ...parent, other: parent.plugin ? parent.other : f.module };
    return parent;
  };

  type Tally = { cpu: number; memory: number; hot: Map<string, number>; alloc: Map<string, number>; modules: Map<string, { cpu: number; memory: number }> };
  const tally = new Map<string, Tally>(), of = (id: string) => {
    let t = tally.get(id);
    if (!t) tally.set(id, t = { cpu: 0, memory: 0, hot: new Map(), alloc: new Map(), modules: new Map() });
    return t;
  };
  const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);
  const book = (c: Charge, special: string | null, field: 'cpu' | 'memory', value: number) => {
    if (special) { of(special)[field] += value; return; }
    if (c.plugin) { const t = of(`plugin:${c.plugin.id}`); t[field] += value; add(field === 'cpu' ? t.hot : t.alloc, c.plugin.hot, value); return; }
    const id = c.core ? 'core' : 'other', t = of(id), module = c.core ?? c.other ?? '原生代码';
    t[field] += value;
    const m = t.modules.get(module) ?? { cpu: 0, memory: 0 }; m[field] += value; t.modules.set(module, m);
  };
  const special = (frame: CallFrame) => frame.url ? null : frame.functionName === '(garbage collector)' ? 'gc' : frame.functionName === '(program)' ? 'other' : null;

  // CPU: walk the tree once from the root, so each node knows its charge; then each sample costs one lookup.
  const nodes = new Map(profile.nodes.map(n => [n.id, n])), charges = new Map<number, Charge>();
  const childIds = new Set(profile.nodes.flatMap(n => n.children ?? []));
  const stack: [number, Charge][] = profile.nodes.filter(n => !childIds.has(n.id)).map(n => [n.id, {}]);
  while (stack.length) {
    const [id, parent] = stack.pop()!, node = nodes.get(id)!, c = charge(node.callFrame, parent);
    charges.set(id, c);
    for (const child of node.children ?? []) stack.push([child, c]);
  }
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  let idle = 0, at = profile.startTime;
  const times = deltas.map(d => at += d);
  samples.forEach((id, i) => {
    // A sample stands for the time until the next one.
    const us = (i + 1 < samples.length ? times[i + 1] : profile.endTime) - times[i];
    if (us <= 0) return;
    const node = nodes.get(id)!, frame = node.callFrame;
    if (!frame.url && frame.functionName === '(idle)') { idle += us; return; }
    if (!frame.url && frame.functionName === '(root)') return;
    book(charges.get(id)!, special(frame), 'cpu', us / 1000);
  });

  // Memory: the sampled allocations still alive, each charged by its allocation stack.
  let memory: number | null = null;
  if (heap) {
    memory = 0;
    const walk: [HeapNode, Charge][] = [[heap, {}]];
    while (walk.length) {
      const [node, parent] = walk.pop()!, c = charge(node.callFrame, parent);
      if (node.selfSize) { memory += node.selfSize; book(c, special(node.callFrame), 'memory', node.selfSize); }
      for (const child of node.children) walk.push([child, c]);
    }
  }

  const top = (map: Map<string, number>): Hot[] => [...map].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, value]) => {
    const [name, where] = key.split('\u0000'); return { name, where, value };
  });
  const owner = (id: string, kind: Owner['kind'], label: string): Owner => {
    const t = tally.get(id);
    return { id, kind, label, cpuMs: t?.cpu ?? 0, memory: memory === null ? null : t?.memory ?? 0, functions: t ? top(t.hot) : [], allocations: t ? top(t.alloc) : [],
      ...kind === 'core' || kind === 'other' ? { modules: t ? [...t.modules].map(([name, m]) => ({ name, cpuMs: m.cpu, memory: m.memory })).sort((a, b) => b.cpuMs - a.cpuMs || b.memory - a.memory).slice(0, 6) : [] } : {} };
  };
  const durationMs = (profile.endTime - profile.startTime) / 1000;
  return {
    durationMs, busyMs: Math.max(0, durationMs - idle / 1000), memory,
    owners: [
      ...plugins.map(p => owner(`plugin:${p.id}`, 'plugin', p.label)),
      owner('core', 'core', 'DSH 内核'), owner('gc', 'gc', '垃圾回收'), owner('other', 'other', '其他'),
    ],
  };
}
