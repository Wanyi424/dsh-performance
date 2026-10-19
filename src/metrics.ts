import { sep } from 'node:path';
import type { Group, Kind, ProcessMetric, RawProcess, RawSample, Sample } from './contracts';

/** Paths compare without case on Windows, where the file system ignores it. */
export const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
/** The plugin whose folder holds this file, if any. */
export function pluginOf(path: string | null | undefined, plugins: readonly { id: string; dir: string }[]) {
  if (!path) return null;
  const file = pathKey(path);
  return plugins.find(p => file.startsWith(pathKey(p.dir) + sep))?.id ?? null;
}

const SERVICES: Record<string, Kind> = { 'network.mojom.NetworkService': 'network', 'storage.mojom.StorageService': 'storage', 'audio.mojom.AudioService': 'audio' };
export function classify(p: Pick<RawProcess, 'role' | 'type' | 'subtype'>): { kind: Kind; group: Group } {
  if (p.role === 'main') return { kind: 'main', group: 'app' };
  if (p.role === 'host') return { kind: 'host', group: 'host' };
  if (p.role === 'tool') return { kind: 'tool', group: 'tools' };
  if (p.type === 'renderer') return { kind: 'renderer', group: 'ui' };
  if (p.type === 'gpu-process') return { kind: 'gpu', group: 'gpu' };
  if (p.type === 'utility') return { kind: (p.subtype && SERVICES[p.subtype]) || 'utility', group: 'app' };
  return { kind: p.type === 'crashpad-handler' ? 'crashpad' : 'other', group: 'app' };
}

export function calculate(current: RawSample, previous?: RawSample, plugins: readonly { id: string; dir: string }[] = []): Sample {
  const elapsed = previous ? current.monotonic - previous.monotonic : 0;
  // CPU is the CPU time used between two samples of one collector session; a long gap would average over unseen time.
  const valid = !!previous && elapsed >= 500 && elapsed <= 10_000 && current.time - previous.time <= 10_000;
  const before = new Map(previous ? [...previous.processes, ...previous.collector ? [previous.collector] : []].map(p => [p.pid, p]) : []);
  const cpu = (row: RawProcess) => {
    if (!valid) return null;
    const old = before.get(row.pid);
    // A process started after the previous sample spent all of its CPU time inside this interval.
    const used = old?.created === row.created ? row.cpuMs - old.cpuMs : row.created >= previous!.time ? row.cpuMs : null;
    return used === null || used < 0 ? null : Math.min(100, used / elapsed / current.cores * 100);
  };
  const processes: ProcessMetric[] = current.processes.map(p => ({
    pid: p.pid, parent: p.parent, created: p.created, name: p.name, threads: p.threads, ...classify(p),
    detail: p.role === 'tool' ? p.command : p.subtype ?? p.type, cpu: cpu(p), memory: p.memory,
    ...p.role === 'tool' ? { path: p.image ?? null, plugin: pluginOf(p.image, plugins) } : {},
  }));
  const memories = processes.flatMap(p => p.memory === null ? [] : [p.memory]);
  const now = current.system, then = previous?.system, total = now && then ? now.kernelMs + now.userMs - then.kernelMs - then.userMs : 0;
  return {
    time: current.time, intervalMs: valid ? elapsed : null, cores: current.cores,
    started: current.processes.find(p => p.role === 'main')?.created ?? current.time,
    cpu: valid ? Math.min(100, processes.reduce((sum, p) => sum + (p.cpu ?? 0), 0)) : null,
    memory: memories.length ? memories.reduce((a, b) => a + b, 0) : null,
    system: now && { cpu: valid && total > 0 ? Math.min(100, Math.max(0, (1 - (now.idleMs - then!.idleMs) / total) * 100)) : null, memoryUsed: now.memoryTotal - now.memoryAvailable, memoryTotal: now.memoryTotal },
    processes, collector: current.collector && { pid: current.collector.pid, cpu: cpu(current.collector), memory: current.collector.memory },
    unavailable: current.unavailable, attribution: null,
  };
}
