import { HISTORY_MS, type Group, type Sample } from './contracts';
import { commandSummary, firstTime, keyOf, programName, programs } from './insights';

/** Per-process trends are kept at this resolution: an hour is 240 buckets per process. */
export const BUCKET_MS = 15_000;
/** One process's or program's trend: bucket start times, the bucket's mean CPU and its last memory reading (NaN when unknown). */
export interface Series { times: number[]; cpu: number[]; memory: number[] }
/** A program the Host started, as seen across samples; `ended` is when it was last seen running. */
export interface ProgramRecord {
  key: string; name: string; summary: string; command: string | null; pid: number; members: number; plugin: string | null;
  started: number; ended: number | null; peakCpu: number | null; peakMemory: number | null;
}
export interface Tracked { series: ReadonlyMap<string, Series>; programs: readonly ProgramRecord[] }
/** The trend key of an owner of the Host's main thread: a plugin (`plugin:<id>`), DSH, garbage collection or the rest. */
export const ownerKey = (id: string) => `owner:${id}`;
/** The trend key of one part of DSH, all its processes together. */
export const groupKey = (group: Group) => `group:${group}`;

/** Statistics of one series inside the range; CPU is the mean of the 15-second buckets. */
export function seriesStats(series: Series | undefined, start: number) {
  if (!series) return { averageCpu: null, peakCpu: null, peakMemory: null, memoryChange: null };
  const from = firstTime(series.times, start);
  const cpus = series.cpu.slice(from).filter(v => !Number.isNaN(v)), memories = series.memory.slice(from).filter(v => !Number.isNaN(v));
  return {
    averageCpu: cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null, peakCpu: cpus.length ? Math.max(...cpus) : null,
    peakMemory: memories.length ? Math.max(...memories) : null, memoryChange: memories.length > 1 ? memories.at(-1)! - memories[0] : null,
  };
}

/**
 * Follows every part of DSH, process, tool program and owner of the Host's main thread from one sample to the next: a coarse
 * trend for each, and when each program started and stopped. It reads only the samples already taken, so it adds no
 * collection. An owner's memory is read every few minutes; each bucket holds the latest reading, so its trend steps.
 */
export class Tracker {
  private series = new Map<string, Series & { n: number }>();
  private records = new Map<string, ProgramRecord & { seen: number }>();
  record(sample: Sample) {
    const bucket = sample.time - sample.time % BUCKET_MS, cutoff = sample.time - HISTORY_MS;
    const put = (key: string, cpu: number | null, memory: number | null) => {
      let s = this.series.get(key);
      if (!s) this.series.set(key, s = { times: [], cpu: [], memory: [], n: 0 });
      const last = s.times.length - 1;
      if (s.times[last] === bucket) {
        if (cpu !== null) { s.cpu[last] = s.n ? (s.cpu[last] * s.n + cpu) / (s.n + 1) : cpu; s.n++; }
        if (memory !== null) s.memory[last] = memory;
      } else {
        s.times.push(bucket); s.cpu.push(cpu ?? NaN); s.memory.push(memory ?? NaN); s.n = cpu === null ? 0 : 1;
        const old = s.times.findIndex(t => t >= cutoff);
        if (old > 0) { s.times.splice(0, old); s.cpu.splice(0, old); s.memory.splice(0, old); }
      }
    };
    const groups = new Map<Group, { cpu: number | null; memory: number | null }>();
    for (const p of sample.processes) {
      const g = groups.get(p.group) ?? { cpu: null, memory: null };
      if (p.cpu !== null) g.cpu = (g.cpu ?? 0) + p.cpu;
      if (p.memory !== null) g.memory = (g.memory ?? 0) + p.memory;
      groups.set(p.group, g);
      if (p.kind !== 'tool') put(keyOf(p), p.cpu, p.memory);
    }
    for (const [group, g] of groups) put(groupKey(group), g.cpu, g.memory);
    const split = sample.attribution;
    if (split) for (const id of new Set([...Object.keys(split.cpu ?? {}), ...Object.keys(split.memory?.owners ?? {})])) put(ownerKey(id), split.cpu?.[id] ?? null, split.memory?.owners[id] ?? null);
    const running = new Set<string>();
    for (const program of programs(sample.processes)) {
      put(program.key, program.cpu, program.memory); running.add(program.key);
      const known = this.records.get(program.key), lead = program.lead;
      this.records.set(program.key, {
        key: program.key, name: programName(lead.name), summary: commandSummary(lead.detail), command: lead.detail, pid: lead.pid, members: program.members.length,
        plugin: program.plugin, started: program.members[0].created, ended: null, seen: sample.time,
        peakCpu: program.cpu === null ? known?.peakCpu ?? null : Math.max(known?.peakCpu ?? 0, program.cpu),
        peakMemory: program.memory === null ? known?.peakMemory ?? null : Math.max(known?.peakMemory ?? 0, program.memory),
      });
    }
    // A program that is gone ended when it was last seen running; with the window hidden, that can be a while before now.
    for (const [key, r] of this.records) {
      if (!running.has(key) && r.ended === null) this.records.set(key, { ...r, ended: r.seen });
      if (r.seen < cutoff) this.records.delete(key);
    }
    // Many one-off commands in an hour: keep the newest few hundred that have ended.
    const ended = [...this.records.values()].filter(r => r.ended !== null);
    for (const r of ended.sort((a, b) => b.seen - a.seen).slice(300)) { this.records.delete(r.key); this.series.delete(r.key); }
    for (const [key, s] of this.series) if (s.times.at(-1)! < cutoff) this.series.delete(key);
  }
  snapshot(): Tracked { return { series: this.series, programs: [...this.records.values()].map(({ seen, ...r }) => r) }; }
}
