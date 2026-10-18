import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, type Hot } from './contracts';
import { pathKey, pluginOf } from './metrics';
import type { PluginDir } from './plugins';

interface CallFrame { functionName: string; url: string; lineNumber: number }
export interface CpuProfile { nodes: { id: number; callFrame: CallFrame; children?: number[] }[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }
export interface HeapNode { callFrame: CallFrame; selfSize: number; children: HeapNode[] }

/** What one owner used, and where: by function (`name\0where`) for a plugin, by package for DSH and the rest. */
export interface Tally { value: number; hot: Map<string, number> }
export type Tallies = Map<string, Tally>;

/** Every owner, in display order: the installed plugins, then DSH, garbage collection and the rest. */
export const ownersOf = (plugins: readonly { id: string }[]) => [...plugins.map(p => `plugin:${p.id}`), ...REST];

/** The largest few entries of a tally as rows. */
export function top(hot: ReadonlyMap<string, number>, n = 5): Hot[] {
  return [...hot].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, value]) => { const [name, where = ''] = key.split('\u0000'); return { name, where, value }; });
}

/** Who a frame's code belongs to: a plugin, a DSH package (or the Node runtime), or a package of neither. */
type Frame = { kind: 'plugin'; id: string; dir: string } | { kind: 'core'; module: string } | { kind: 'other'; module: string } | null;
/** What a sample or allocation is charged to: the nearest plugin frame on its stack, else the nearest DSH or other package. */
interface Charge { plugin?: { id: string; hot: string }; core?: string; other?: string }

function packageOf(path: string) {
  const parts = path.split(/[\\/]/), at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return null;
  return parts[at + 1].startsWith('@') ? `${parts[at + 1]}/${parts[at + 2] ?? ''}` : parts[at + 1];
}
const pathOf = (url: string) => { try { return url.startsWith('file:') ? fileURLToPath(url.split(/[?#]/)[0]) : url; } catch { return url; } };
const special = (frame: CallFrame) => frame.url ? null : frame.functionName === '(garbage collector)' ? 'gc' : frame.functionName === '(program)' ? 'other' : null;

/**
 * Charges the Host's CPU profiles and sampling heap profiles to plugins. A sample counts for the nearest plugin frame on its
 * stack, so DSH code that a plugin calls synchronously is that plugin's time; with no plugin on the stack it is DSH's,
 * grouped by package. Work DSH does later on a plugin's behalf (after an await) carries no plugin frame and stays DSH's.
 * Scripts are classified once each, until the list of plugins changes.
 */
export class Attributor {
  private frames = new Map<string, Frame>();
  private plugins: readonly PluginDir[] = [];
  private readonly rootKey: string;
  constructor(root: string) { this.rootKey = pathKey(root) + sep; }

  private use(plugins: readonly PluginDir[]) { if (plugins !== this.plugins) { this.plugins = plugins; this.frames.clear(); } }
  private frameOf(url: string): Frame {
    let known = this.frames.get(url);
    if (known !== undefined) return known;
    if (!url) known = null;
    else if (url.startsWith('node:')) known = { kind: 'core', module: 'Node.js' };
    else {
      const path = pathOf(url), plugin = pluginOf(path, this.plugins), module = packageOf(path) ?? path.split(/[\\/]/).at(-1) ?? path;
      if (plugin) known = { kind: 'plugin', id: plugin, dir: this.plugins.find(p => p.id === plugin)!.dir };
      else known = pathKey(path).startsWith(this.rootKey) ? { kind: 'core', module } : { kind: 'other', module };
      // A frame from DSH's own folder outside node_modules (its entry files) is still DSH.
      if (known.kind === 'core' && !packageOf(path)) known = { kind: 'core', module: 'DeepSeek Harness' };
    }
    this.frames.set(url, known);
    return known;
  }
  private charge(frame: CallFrame, parent: Charge): Charge {
    const f = this.frameOf(frame.url);
    if (f?.kind === 'plugin') {
      const where = relative(f.dir, pathOf(frame.url)).split(sep).join('/');
      return { plugin: { id: f.id, hot: `${frame.functionName || '（匿名函数）'}\u0000${where}:${frame.lineNumber + 1}` }, core: parent.core, other: parent.other };
    }
    if (f?.kind === 'core') return { ...parent, core: parent.plugin ? parent.core : f.module };
    if (f?.kind === 'other') return { ...parent, other: parent.plugin ? parent.other : f.module };
    return parent;
  }
  private static book(tallies: Tallies, c: Charge, kind: string | null, value: number) {
    const id = kind === 'gc' ? 'gc' : c.plugin && !kind ? `plugin:${c.plugin.id}` : c.core && !kind ? 'core' : 'other';
    let t = tallies.get(id);
    if (!t) tallies.set(id, t = { value: 0, hot: new Map() });
    t.value += value;
    if (id === 'gc') return;
    const key = id.startsWith('plugin:') ? c.plugin!.hot : kind ? '原生代码' : c.core ?? c.other ?? '原生代码';
    t.hot.set(key, (t.hot.get(key) ?? 0) + value);
  }

  /** Busy time of one profile window by owner, in ms; `(idle)` is idle and `(root)` carries no time. */
  cpu(profile: CpuProfile, plugins: readonly PluginDir[]): { durationMs: number; busyMs: number; owners: Tallies } {
    this.use(plugins);
    // Walk the tree once from the root, so each node knows its charge; then each sample costs one lookup.
    const nodes = new Map(profile.nodes.map(n => [n.id, n])), charges = new Map<number, Charge>(), owners: Tallies = new Map();
    const childIds = new Set(profile.nodes.flatMap(n => n.children ?? []));
    const stack: [number, Charge][] = profile.nodes.filter(n => !childIds.has(n.id)).map(n => [n.id, {}]);
    while (stack.length) {
      const [id, parent] = stack.pop()!, node = nodes.get(id)!, c = this.charge(node.callFrame, parent);
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
      const frame = nodes.get(id)!.callFrame;
      if (!frame.url && frame.functionName === '(idle)') { idle += us; return; }
      if (!frame.url && frame.functionName === '(root)') return;
      Attributor.book(owners, charges.get(id)!, special(frame), us / 1000);
    });
    const durationMs = (profile.endTime - profile.startTime) / 1000;
    return { durationMs, busyMs: Math.max(0, durationMs - idle / 1000), owners };
  }

  /** The sampled allocations still alive, in bytes by owner, each charged by its allocation stack. */
  heap(head: HeapNode, plugins: readonly PluginDir[]): { bytes: number; owners: Tallies } {
    this.use(plugins);
    const owners: Tallies = new Map(), walk: [HeapNode, Charge][] = [[head, {}]];
    let bytes = 0;
    while (walk.length) {
      const [node, parent] = walk.pop()!, c = this.charge(node.callFrame, parent);
      if (node.selfSize) { bytes += node.selfSize; Attributor.book(owners, c, special(node.callFrame), node.selfSize); }
      for (const child of node.children) walk.push([child, c]);
    }
    return { bytes, owners };
  }
}
