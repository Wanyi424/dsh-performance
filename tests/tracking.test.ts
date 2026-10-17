import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracker } from '../src/tracking';
import type { ProcessMetric, Sample } from '../src/contracts';

const proc = (pid: number, parent: number, name: string, extra: Partial<ProcessMetric> = {}): ProcessMetric =>
  ({ pid, parent, created: pid * 1000, name, kind: 'tool', group: 'tools', threads: 1, detail: null, cpu: 1, memory: 100, ...extra });
const main = proc(1, 0, 'DeepSeek Harness.exe', { kind: 'main', group: 'app', created: 0, memory: 50 });
const sample = (time: number, ...processes: ProcessMetric[]) => ({ time, intervalMs: 2000, processes: [main, ...processes] }) as Sample;

test('each process and tool program keeps a 15-second trend: mean CPU, last memory', () => {
  const t = new Tracker();
  t.record(sample(30_000, proc(5, 3, 'pwsh.exe', { cpu: 2, memory: 100 })));
  t.record(sample(32_000, proc(5, 3, 'pwsh.exe', { cpu: 4, memory: 120 })));
  t.record(sample(34_000, proc(5, 3, 'pwsh.exe', { cpu: null, memory: 130 })));
  t.record(sample(46_000, proc(5, 3, 'pwsh.exe', { cpu: 6, memory: 90 })));
  const series = t.snapshot().series.get('5:5000')!;
  assert.deepEqual(series.times, [30_000, 45_000]); assert.deepEqual(series.cpu, [3, 6]); assert.deepEqual(series.memory, [130, 90]);
  assert.deepEqual(t.snapshot().series.get('1:0')!.memory, [50, 50]);
});

test('programs are recorded from their own start to when they were last seen, with their peaks', () => {
  const t = new Tracker();
  const runner = proc(5, 3, 'DeepSeek Harness.exe', { memory: 30 }), shell = proc(6, 5, 'pwsh.exe', { detail: 'pwsh.exe -NoLogo', memory: 60, cpu: 3 });
  t.record(sample(20_000, runner));
  t.record(sample(22_000, runner, shell));
  t.record(sample(24_000, runner, { ...shell, memory: 40, cpu: 1 }));
  t.record(sample(26_000));
  const [record] = t.snapshot().programs;
  assert.equal(record.name, 'PowerShell'); assert.equal(record.summary, '-NoLogo'); assert.equal(record.members, 2);
  assert.equal(record.started, 5000); assert.equal(record.ended, 24_000);
  assert.equal(record.peakMemory, 90); assert.equal(record.peakCpu, 4);
  t.record(sample(24_000 + 3_600_001));
  assert.equal(t.snapshot().programs.length, 0); assert.equal(t.snapshot().series.has('5:5000'), false);
});
