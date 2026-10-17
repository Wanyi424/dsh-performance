// Optional, read-only probe of a running DSH: pass the desktop main PID. It does not install the plugin; the real Host is
// recognised by its command line, so its tool processes are counted as they would be inside DSH.
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Sampler } from '../src/collector';
import type { Sample } from '../src/contracts';
const root = process.argv[2]; if (!root || !/^\d+$/.test(root)) throw new Error('Usage: node --import tsx scripts/benchmark.ts <desktop-main-pid>');
const sampler = new Sampler(resolve('lib/collector.exe'), [String(process.pid), root]);
try {
  const samples: Sample[] = [], roundTrips: number[] = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now(); samples.push(await sampler.sample()); roundTrips.push(performance.now() - start);
    if (i < 11) await new Promise(r => setTimeout(r, 2100));
  }
  const warm = samples.slice(2), last = samples.at(-1)!;
  const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const report = {
    sampleCount: samples.length, cores: last.cores,
    processes: last.processes.map(p => ({ pid: p.pid, parent: p.parent, kind: p.kind, name: p.name, memoryMB: p.memory === null ? null : +(p.memory / 1024 ** 2).toFixed(1) })),
    totalCpuPercent: last.cpu, totalMemoryMB: last.memory === null ? null : +(last.memory / 1024 ** 2).toFixed(1), unavailable: last.unavailable,
    machine: last.system && { cpuPercent: last.system.cpu, memoryUsedMB: Math.round(last.system.memoryUsed / 1024 ** 2), memoryTotalMB: Math.round(last.system.memoryTotal / 1024 ** 2) },
    coldRoundTripMs: roundTrips[0], warmRoundTripMs: average(roundTrips.slice(2)),
    collectorAverageCpuPercent: average(warm.map(s => s.collector?.cpu ?? 0)),
    collectorMaxPrivateWorkingSetMB: Math.max(...samples.map(s => s.collector?.memory ?? 0)) / 1024 ** 2,
  };
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/benchmark.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { sampler.dispose(); }
