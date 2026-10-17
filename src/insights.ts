import { GROUPS, type Group, type Point, type ProcessMetric, type Sample } from './contracts';
import type { Frame, Interaction, Span } from './responsiveness';

/** Samples further apart than this are a break in observation (hidden window, failure), never joined by a line. */
export const GAP_MS = 10_000;
const INDEX = new Map<Group, number>(GROUPS.map((g, i) => [g, i]));
export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export function pointOf(s: Sample): Point {
  const cpu = s.intervalMs === null ? null : GROUPS.map(() => 0), memory = s.memory === null ? null : GROUPS.map(() => 0);
  for (const p of s.processes) {
    const i = INDEX.get(p.group)!;
    if (cpu && p.cpu !== null) cpu[i] += p.cpu;
    if (memory && p.memory !== null) memory[i] += p.memory;
  }
  return { time: s.time, intervalMs: s.intervalMs, cpu, memory, systemCpu: s.system?.cpu ?? null, systemMemory: s.system?.memoryUsed ?? null };
}

/**
 * Points for drawing, at most one per `bucketMs`: CPU is averaged and memory takes the bucket's last reading. A long range
 * then costs a path of about the plot's width instead of every sample; statistics always use the full points.
 */
export function decimate(points: Point[], from: number, to: number, bucketMs: number): Point[] {
  if (to - from < 2 || (points[to - 1].time - points[from].time) / (to - from) >= bucketMs) return points.slice(from, to);
  const out: Point[] = [];
  let bucket = NaN, cpu: number[] | null = null, count = 0, last: Point | undefined;
  const flush = () => { if (last) out.push({ ...last, cpu: cpu && cpu.map(v => v / count) }); };
  for (let i = from; i < to; i++) {
    const p = points[i], b = Math.floor(p.time / bucketMs);
    if (b !== bucket) { flush(); bucket = b; cpu = null; count = 0; }
    if (p.cpu) { cpu = cpu ? cpu.map((v, g) => v + p.cpu![g]) : [...p.cpu]; count++; }
    last = p;
  }
  flush();
  return out;
}

/** Index of the first item at or after `time`; items are in time order. */
export function firstAt(items: { time: number }[], time: number) {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid].time < time) lo = mid + 1; else hi = mid; }
  return lo;
}
/** The same search over a plain list of times. */
export function firstTime(times: number[], time: number) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < time) lo = mid + 1; else hi = mid; }
  return lo;
}

export interface Summary {
  averageCpu: number | null; peakCpu: number | null; peakMemory: number | null; peakCpuAt: number | null; peakMemoryAt: number | null;
  /** Memory now against the first reading in the range, and when that reading was taken. */
  memoryChange: number | null; since: number | null;
}
export function summarize(points: Point[], start: number, end: number): Summary {
  let weighted = 0, weight = 0, peakCpu: number | null = null, peakMemory: number | null = null, peakCpuAt: number | null = null, peakMemoryAt: number | null = null;
  let first: Point | undefined, last: Point | undefined;
  for (let i = firstAt(points, start); i < points.length && points[i].time <= end; i++) {
    const p = points[i];
    if (p.cpu) {
      const total = sum(p.cpu), ms = p.time - Math.max(start, p.time - p.intervalMs!);
      // Time weighted, so a burst of quick samples does not outweigh a calm stretch; an interval crossing the start counts in part.
      if (ms > 0) { weighted += total * ms; weight += ms; }
      if (peakCpu === null || total > peakCpu) { peakCpu = total; peakCpuAt = p.time; }
    }
    if (p.memory) {
      const total = sum(p.memory);
      if (peakMemory === null || total > peakMemory) { peakMemory = total; peakMemoryAt = p.time; }
      first ??= p; last = p;
    }
  }
  return {
    averageCpu: weight ? weighted / weight : null, peakCpu, peakMemory, peakCpuAt, peakMemoryAt,
    memoryChange: first && last && first !== last ? sum(last.memory!) - sum(first.memory!) : null, since: first && first !== last ? first.time : null,
  };
}

/** Interactions slower than this feel sluggish; the same line web vitals draw for a good INP. */
export const SLOW_INTERACTION_MS = 200;
export interface ResponseSummary { frames: number; longestFrame: number | null; longestFrameAt: number | null; slow: number; slowest: number | null; slowestAt: number | null; observedMs: number }
export function summarizeResponse(frames: Frame[], interactions: Interaction[], spans: Span[], start: number, end: number): ResponseSummary {
  let count = 0, longestFrame: number | null = null, longestFrameAt: number | null = null, slow = 0, slowest: number | null = null, slowestAt: number | null = null;
  for (let i = firstAt(frames, start); i < frames.length && frames[i].time <= end; i++) {
    const f = frames[i]; count++;
    if (longestFrame === null || f.duration > longestFrame) { longestFrame = f.duration; longestFrameAt = f.time; }
  }
  for (let i = firstAt(interactions, start); i < interactions.length && interactions[i].time <= end; i++) {
    const x = interactions[i]; if (x.duration >= SLOW_INTERACTION_MS) slow++;
    if (slowest === null || x.duration > slowest) { slowest = x.duration; slowestAt = x.time; }
  }
  return { frames: count, longestFrame, longestFrameAt, slow, slowest, slowestAt, observedMs: sum(spans.map(s => Math.max(0, Math.min(end, s.end) - Math.max(start, s.start)))) };
}

/** Processes that only carry another program: DSH's own job runner (Node mode) and console hosts. */
const WRAPPERS = /^(deepseek harness|conhost|openconsole)\.exe$/i;
const FRIENDLY: Record<string, string> = {
  pwsh: 'PowerShell', powershell: 'Windows PowerShell', cmd: '命令提示符', node: 'Node.js', python: 'Python', python3: 'Python', pythonw: 'Python',
  py: 'Python', bash: 'Bash', git: 'Git', java: 'Java', deno: 'Deno', bun: 'Bun', uv: 'uv', conhost: '控制台主机', openconsole: '控制台主机',
};
export function programName(exe: string) {
  const base = exe.replace(/\.exe$/i, '');
  return FRIENDLY[base.toLowerCase()] ?? base;
}
/** Arguments after the executable, with paths shortened to their last part, so the line says what the program is running. */
export function commandSummary(command: string | null) {
  const tokens = command?.match(/"[^"]*"|\S+/g) ?? [];
  return tokens.slice(1).map(token => {
    const value = token.replace(/^"(.*)"$/, '$1');
    return /^[-/]{1,2}[\w?]/.test(value) || !/[\\/]/.test(value) ? value : value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
  }).join(' ');
}

/** A program the Host started, with everything it started in turn; `lead` is the process that names it. */
export interface Program { key: string; lead: ProcessMetric; members: ProcessMetric[]; cpu: number | null; memory: number | null; plugin: string | null }
export function programs(processes: ProcessMetric[]): Program[] {
  const tools = processes.filter(p => p.kind === 'tool'), byPid = new Map(tools.map(p => [p.pid, p])), children = new Map<number, ProcessMetric[]>();
  for (const p of tools) if (byPid.has(p.parent)) children.set(p.parent, [...children.get(p.parent) ?? [], p]);
  return tools.filter(p => !byPid.has(p.parent)).map(top => {
    const members: ProcessMetric[] = [];
    const visit = (p: ProcessMetric) => { members.push(p); (children.get(p.pid) ?? []).sort((a, b) => a.created - b.created).forEach(visit); };
    visit(top);
    const cpus = members.flatMap(p => p.cpu === null ? [] : [p.cpu]), memories = members.flatMap(p => p.memory === null ? [] : [p.memory]);
    const lead = members.find(p => !WRAPPERS.test(p.name)) ?? top;
    return { key: keyOf(top), lead, members, cpu: cpus.length ? sum(cpus) : null, memory: memories.length ? sum(memories) : null, plugin: top.plugin ?? lead.plugin ?? null };
  });
}

export const keyOf = (p: Pick<ProcessMetric, 'pid' | 'created'>) => `${p.pid}:${p.created}`;
export type SortKey = 'cpu' | 'memory';
export const byUsage = <T extends { cpu: number | null; memory: number | null }>(key: SortKey) => (a: T, b: T) => (b[key] ?? -1) - (a[key] ?? -1);
