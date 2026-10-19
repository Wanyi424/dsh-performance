import { GROUPS, type Group, type PluginInfo, type Point, type Sample } from './contracts';
import { clockShort, span } from './format';
import { byUsage, commandSummary, firstAt, groupAverages, hostSplit, keyOf, programName, programTitle, programs, sum, type SortKey } from './insights';
import { GROUP_ABOUT, GROUP_LABEL, KIND, OWNER_LABEL, SELF } from './labels';
import { BUCKET_MS, groupKey, ownerKey, seriesStats, type ProgramRecord, type Series, type Tracked } from './tracking';

const MB = 1024 ** 2, HOST = GROUPS.indexOf('host');
/**
 * A line below both over the range barely uses anything. It is greyed rather than folded away: most installed plugins sit
 * idle most of the time, and a second fold inside an open part costs another click to see them all.
 */
const IDLE = { cpu: .05, memory: 5 * MB };
/** The headings the Host's lines sit under: its plugins, then what is not a plugin. */
const HEADING = { plugins: '插件', rest: '不属于插件' } as const;

/** One line of「谁在占用」. */
export interface Row {
  /** What the drawer opens for it: `group:<g>`, a process or program key, or `owner:<id>`. */
  key: string; group: Group; name: string;
  /** What it is, in a few words: the list's「说明」column. */
  note: string;
  /** A short label beside the name: for a program a plugin ships, that plugin's name; for this plugin,「本插件」; for the Host, a paused split. */
  tag?: string;
  /** CPU is the average over the range (a program's, over the part of it that it ran); memory is now, or an ended program's peak. */
  cpu: number | null; memory: number | null;
  /** The memory is the profiler's sampled estimate: plugins, DSH itself and the rest. */
  estimate?: boolean;
  series?: Series;
  /** Its lines when opened, in the order the list shows them. */
  children?: Row[];
  /** The heading it is listed under in its part, shown once over a run of lines alike: the Host's plugins, and the rest. */
  heading?: string;
  /** A program that ended: every run of the same command in the range, newest first. */
  runs?: ProgramRecord[];
}
export interface Breakdown { dsh: Row[]; programs: Row[]; ended: Row[]; endedCount: number }
/** Barely used over the range, CPU and memory both: the list greys such a line, so what is busy stands out. */
export const idle = (r: Pick<Row, 'cpu' | 'memory'>) => r.cpu !== null && r.cpu < IDLE.cpu && (r.memory ?? 0) < IDLE.memory;

/** What a reading's Host CPU leaves after its owners: its other threads, or all of it when the reading carries no split. */
export const restOf = (p: Point) => p.cpu ? Math.max(0, p.cpu[HOST] - (p.owners ? sum(Object.values(p.owners)) : 0)) : null;
/** The list's「其他」: garbage collection, other code and the rest together. */
export const miscOf = (p: Point) => { const rest = restOf(p); return rest === null ? null : rest + (p.owners?.gc ?? 0) + (p.owners?.other ?? 0); };
/** A trend from the readings themselves, in the tracker's buckets, for what keeps no series of its own. */
export function pointSeries(points: Point[], start: number, pick: (p: Point) => number | null): Series {
  const s: Series = { times: [], cpu: [], memory: [] };
  let n = 0;
  for (let i = firstAt(points, start - BUCKET_MS); i < points.length; i++) {
    const p = points[i], v = pick(p), bucket = p.time - p.time % BUCKET_MS, last = s.times.length - 1;
    if (s.times[last] !== bucket) { s.times.push(bucket); s.cpu.push(v ?? NaN); s.memory.push(NaN); n = v === null ? 0 : 1; }
    else if (v !== null) { s.cpu[last] = n ? (s.cpu[last] * n + v) / (n + 1) : v; n++; }
  }
  return s;
}

/** Each plugin's own processes: programs started from its folder, and for this plugin its collector. */
export function helpersOf(sample?: Sample) {
  const helpers = new Map<string, { count: number; cpu: number | null; memory: number | null }>();
  const add = (id: string, cpu: number | null, memory: number | null) => {
    const h = helpers.get(id) ?? { count: 0, cpu: null, memory: null };
    helpers.set(id, { count: h.count + 1, cpu: cpu === null ? h.cpu : (h.cpu ?? 0) + cpu, memory: memory === null ? h.memory : (h.memory ?? 0) + memory });
  };
  for (const p of programs(sample?.processes ?? [])) if (p.plugin) add(p.plugin, p.cpu, p.memory);
  if (sample?.collector) add(SELF, sample.collector.cpu, sample.collector.memory);
  return helpers;
}

/**
 * The list behind「谁在占用」: DSH by part, the Host opening into its plugins, DSH itself and「其他」so the lines add up to
 * the Host; then the programs DSH started, and those that ended in the range. CPU is averaged over the range throughout, so
 * the order holds still from one reading to the next; memory is the latest reading.
 */
export function breakdown({ sample, points, tracked, plugins, start, end, sort }: {
  sample?: Sample; points: Point[]; tracked: Tracked; plugins: readonly PluginInfo[]; start: number; end: number; sort: SortKey;
}): Breakdown {
  const order = byUsage<Row>(sort), averages = groupAverages(points, start, end), split = hostSplit(points, start, end);
  const average = (key: string) => seriesStats(tracked.series.get(key), start).averageCpu;
  const labelOf = (id: string | null) => id ? plugins.find(p => p.id === id)?.label ?? id : undefined;
  const own = sample?.processes.filter(p => p.kind !== 'tool') ?? [], a = sample?.attribution;

  // Without a single split in the range (paused, or not available here), the plugins are unknown rather than idle.
  const splitSeen = !!split && Object.keys(split.owners).length > 0, held = a?.memory?.owners, helpers = helpersOf(sample);
  const owner = (id: string, name: string, note: string, heading: string, tag?: string): Row => ({ key: ownerKey(id), group: 'host', name, note, tag, heading,
    estimate: true, cpu: splitSeen ? split!.owners[id] ?? 0 : null, memory: held?.[id] ?? null, series: tracked.series.get(ownerKey(id)) });
  // A plugin's note names its package and version, so a developer can tell exactly which one it is.
  const plugged = plugins.map(p => {
    const h = helpers.get(p.id);
    return owner(`plugin:${p.id}`, p.label, [p.id, p.version && `v${p.version}`, h && `自带 ${h.count} 个程序`].filter(Boolean).join(' · '), HEADING.plugins,
      p.id === SELF ? '本插件' : undefined);
  }).sort(order);
  // Every plugin, busiest first; then, under a heading of their own, DSH itself and「其他」.
  const hostLines = (): Row[] => [...plugged, owner('core', OWNER_LABEL.core.label, OWNER_LABEL.core.note, HEADING.rest), {
    key: ownerKey('misc'), group: 'host', name: OWNER_LABEL.misc.label, note: OWNER_LABEL.misc.note, heading: HEADING.rest, estimate: true,
    cpu: split ? (split.owners.gc ?? 0) + (split.owners.other ?? 0) + split.rest : null, memory: held?.other ?? null, series: pointSeries(points, start, miscOf),
  }];

  const dsh = (['ui', 'gpu', 'app', 'host'] as const).flatMap((g): Row[] => {
    const members = own.filter(p => p.group === g), memories = members.flatMap(p => p.memory === null ? [] : [p.memory]);
    if (!members.length) return [];
    const row: Row = { key: groupKey(g), group: g, name: GROUP_LABEL[g], note: GROUP_ABOUT[g].note, series: tracked.series.get(groupKey(g)),
      cpu: averages?.[GROUPS.indexOf(g)] ?? null, memory: memories.length ? sum(memories) : null };
    // A part that opens says how many lines it opens into, which also shows while it is closed.
    if (g === 'host') return [{ ...row, children: hostLines(), cpu: split?.total ?? row.cpu, note: plugins.length ? `${row.note} · ${plugins.length} 个插件` : row.note,
      tag: a?.state === 'paused' ? '插件统计已暂停' : undefined }];
    if (members.length > 1) {
      row.note += ` · ${members.length} 个进程`;
      row.children = members.map((p): Row => ({ key: keyOf(p), group: g, name: KIND[p.kind].label, cpu: average(keyOf(p)), memory: p.memory,
        note: p.kind === 'utility' && p.detail ? p.detail.split('.').at(-1)! : KIND[p.kind].note, series: tracked.series.get(keyOf(p)) })).sort(order);
    }
    return [row];
  }).sort(order);

  const running = programs(sample?.processes ?? []), live = new Set(running.map(p => p.key));
  const programRows = running.map((p): Row => {
    const summary = commandSummary(p.lead.detail);
    return { key: p.key, group: 'tools', name: programTitle(programName(p.lead.name), summary), tag: labelOf(p.plugin), cpu: average(p.key) ?? p.cpu, memory: p.memory,
      series: tracked.series.get(p.key), note: [summary || p.lead.name, p.shell && `在 ${programName(p.shell.name)} 中运行`, p.members.length > 1 && `${p.members.length} 个进程`].filter(Boolean).join(' · ') };
  }).sort(order);

  const ended = tracked.programs.filter(r => r.ended !== null && !live.has(r.key) && r.ended >= start).sort((x, y) => y.ended! - x.ended!);
  // An agent runs the same command again and again: one line per command, opening its latest run.
  const same = new Map<string, ProgramRecord[]>();
  for (const r of ended) { const id = `${r.name}\u0000${r.summary}`; same.set(id, [...same.get(id) ?? [], r]); }
  const endedRows = [...same.values()].map((runs): Row => {
    const r = runs[0], title = programTitle(r.name, r.summary), ran = sum(runs.map(x => x.ended! - x.started));
    return { key: r.key, group: 'tools', name: runs.length > 1 ? `${title} × ${runs.length}` : title, tag: labelOf(r.plugin), runs, cpu: average(r.key),
      memory: Math.max(0, ...runs.map(x => x.peakMemory ?? 0)) || null, series: tracked.series.get(r.key),
      note: [runs.length > 1 ? `最近 ${clockShort(r.ended!)} 退出 · 共运行 ${span(ran)}` : `${clockShort(r.started)}–${clockShort(r.ended!)} · 运行 ${span(ran)}`, r.summary].filter(Boolean).join(' · ') };
  });
  return { dsh, programs: programRows, ended: endedRows, endedCount: ended.length };
}

/** Every line the list shows now, top to bottom: the drawer's up and down step through them in this order. */
export function visibleKeys(data: Breakdown, expanded: ReadonlySet<string>, endedOpen: boolean) {
  const keys: string[] = [];
  for (const r of [...data.dsh, ...data.programs]) { keys.push(r.key); if (expanded.has(r.key)) keys.push(...(r.children ?? []).map(c => c.key)); }
  if (endedOpen) keys.push(...data.ended.map(r => r.key));
  return keys;
}
/** Every row by key, closed ones included, so a drawer shows the same figures as the list. */
export function rowIndex(data: Breakdown) {
  const rows = new Map<string, Row>();
  const add = (r: Row) => { rows.set(r.key, r); r.children?.forEach(add); };
  [...data.dsh, ...data.programs, ...data.ended].forEach(add);
  return rows;
}
