import { HISTORY_MS, type Sample } from './contracts';
import { commandSummary, keyOf, programName, programs } from './insights';

/** Per-process trends are kept at this resolution: an hour is 240 buckets per process. */
export const BUCKET_MS = 15_000;
/** One process's or program's trend: bucket start times, the bucket's mean CPU and its last memory reading (NaN when unknown). */
export interface Series { times: number[]; cpu: number[]; memory: number[] }
/** A program the Host started, as seen across samples; `ended` is when it was last seen running. */
export interface ProgramRecord {
  key: string; name: string; summary: string; command: string | null; pid: number; members: number;
  started: number; ended: number | null; peakCpu: number | null; peakMemory: number | null;
}
export interface Tracked { series: ReadonlyMap<string, Series>; programs: readonly ProgramRecord[] }

/**
 * Follows every DSH process and tool program from one sample to the next: a coarse trend for each, and when each program
 * started and stopped. It reads only the samples already taken, so it adds no collection.
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
    for (const p of sample.processes) if (p.kind !== 'tool') put(keyOf(p), p.cpu, p.memory);
    const running = new Set<string>();
    for (const program of programs(sample.processes)) {
      put(program.key, program.cpu, program.memory); running.add(program.key);
      const known = this.records.get(program.key), lead = program.lead;
      this.records.set(program.key, {
        key: program.key, name: programName(lead.name), summary: commandSummary(lead.detail), command: lead.detail, pid: lead.pid, members: program.members.length,
        started: program.members[0].created, ended: null, seen: sample.time,
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
