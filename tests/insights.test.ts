import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSummary, decimate, ownerAverages, pointOf, programName, programs, summarize, summarizeResponse } from '../src/insights';
import type { Point, ProcessMetric, Sample } from '../src/contracts';

const point = (time: number, cpu: number | null, memory: number, intervalMs: number | null = 2000): Point =>
  ({ time, intervalMs: cpu === null ? null : intervalMs, cpu: cpu === null ? null : [cpu, 0, 0, 0, 0], memory: [memory, 0, 0, 0, 0], systemCpu: null, systemMemory: null, owners: null });
const proc = (pid: number, parent: number, name: string, extra: Partial<ProcessMetric> = {}): ProcessMetric =>
  ({ pid, parent, created: pid, name, kind: 'tool', group: 'tools', threads: 1, detail: null, cpu: 1, memory: 10, ...extra });

test('history points keep per-group sums in chart order', () => {
  const sample = { intervalMs: 2000, memory: 60, system: { cpu: 40, memoryUsed: 900, memoryTotal: 1600 }, processes: [
    proc(1, 0, 'a', { kind: 'renderer', group: 'ui', cpu: 2, memory: 30 }), proc(2, 0, 'b', { kind: 'host', group: 'host', cpu: 1, memory: 20 }),
    proc(3, 2, 'c', { cpu: null, memory: 10 }),
  ] } as Sample;
  assert.deepEqual(pointOf({ ...sample, time: 5 }), { time: 5, intervalMs: 2000, cpu: [2, 0, 0, 1, 0], memory: [30, 0, 0, 20, 10], systemCpu: 40, systemMemory: 900, owners: null });
  assert.equal(pointOf({ ...sample, time: 5, intervalMs: null }).cpu, null);
  const owners = { 'plugin:a': .5, core: .25, gc: 0, other: 0 };
  assert.equal(pointOf({ ...sample, time: 5, attribution: { cpu: owners, memory: null, startPauseMs: 1, error: null } }).owners, owners);
});

test('owner shares over a range are time weighted, and only readings with the Host\'s split count', () => {
  const at = (time: number, owners: Record<string, number> | null, intervalMs = 2000) => ({ ...point(time, 1, 0, intervalMs), owners });
  const points = [at(1000, { a: 9 }), at(3000, { a: 1, b: 2 }), at(4000, null), at(6000, { a: 4, b: 0 })];
  // a: 1 over 1000 ms (2000–3000) and 4 over 2000 ms; b counted where present: 2 over 1000 ms, 0 over 2000 ms.
  assert.deepEqual(ownerAverages(points, 2000, 6000), { a: 3, b: 2 / 3 });
  assert.equal(ownerAverages([at(1000, null)], 0, 2000), null);
});

test('range average is time weighted and cuts the interval crossing the start; memory change says since when', () => {
  const points = [point(1000, 50, 100), point(3000, 10, 110), point(4000, 40, 130, 1000), point(6000, null, 120), point(9000, 20, 125)];
  const s = summarize(points, 2000, 9000);
  // 10% over 1000 ms (2000–3000), 40% over 1000 ms, 20% over 2000 ms: 90 / 4000 ms.
  assert.equal(s.averageCpu, 22.5); assert.equal(s.peakCpu, 40); assert.equal(s.peakMemory, 130);
  assert.equal(s.memoryChange, 15); assert.equal(s.since, 3000); assert.equal(s.peakCpuAt, 4000); assert.equal(s.peakMemoryAt, 4000);
  assert.deepEqual(summarize([point(1000, null, 100)], 0, 2000),
    { averageCpu: null, peakCpu: null, peakMemory: 100, peakCpuAt: null, peakMemoryAt: 1000, memoryChange: null, since: null });
});

test('responsiveness counts stutters and slow interactions within the range, and only listened time as observed', () => {
  const frames = [{ time: 500, duration: 60 }, { time: 1500, duration: 120 }, { time: 2500, duration: 80 }];
  const interactions = [{ id: 1, time: 1200, duration: 48, kind: 'key' as const }, { id: 2, time: 2200, duration: 260, kind: 'pointer' as const }, { id: 3, time: 3500, duration: 400, kind: 'pointer' as const }];
  assert.deepEqual(summarizeResponse(frames, interactions, [{ start: 0, end: 1000 }, { start: 2000, end: 4000 }], 1000, 3000),
    { frames: 2, longestFrame: 120, longestFrameAt: 1500, slow: 1, slowest: 260, slowestAt: 2200, observedMs: 1000 });
  assert.deepEqual(summarizeResponse([], [], [], 0, 1000), { frames: 0, longestFrame: null, longestFrameAt: null, slow: 0, slowest: null, slowestAt: null, observedMs: 0 });
});

test('a long range is drawn from fewer points: CPU averaged per bucket, memory as the bucket closes', () => {
  const points = Array.from({ length: 8 }, (_, i) => point(i * 2000, i, 100 + i));
  const drawn = decimate(points, 0, 8, 8000);
  assert.deepEqual(drawn.map(p => [p.time, p.cpu![0], p.memory![0]]), [[6000, 1.5, 103], [14000, 5.5, 107]]);
  assert.equal(decimate(points, 0, 8, 1000).length, 8);
  assert.equal(decimate(points, 2, 5, 8000).length, 2);
});

test('a tool program gathers its descendants and is named by the first process that is not a runner or console host', () => {
  const list = [
    proc(20, 13, 'DeepSeek Harness.exe', { memory: 30 }), proc(21, 20, 'pwsh.exe', { detail: 'pwsh.exe -NoLogo', memory: 60 }), proc(22, 21, 'node.exe', { cpu: null, memory: 200 }),
    proc(23, 21, 'conhost.exe', { memory: 5 }),
    proc(30, 13, 'conhost.exe', { memory: 6 }),
    proc(40, 13, 'python.exe', { memory: null, cpu: null }),
    proc(13, 10, 'DeepSeek Harness.exe', { kind: 'host', group: 'host' }),
  ];
  const [shell, terminal, python] = programs(list);
  assert.equal(shell.lead.pid, 21); assert.deepEqual(shell.members.map(p => p.pid), [20, 21, 22, 23]);
  assert.equal(shell.cpu, 3); assert.equal(shell.memory, 295);
  assert.equal(terminal.lead.pid, 30); assert.equal(terminal.members.length, 1);
  assert.equal(python.cpu, null); assert.equal(python.memory, null);
  assert.equal(programs(list).length, 3);
});

test('tool names and command lines are shortened to what identifies them', () => {
  assert.equal(programName('pwsh.exe'), 'PowerShell'); assert.equal(programName('Code.exe'), 'Code'); assert.equal(programName('conhost.exe'), '控制台主机');
  assert.equal(commandSummary('"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\app\\node_modules\\vite\\bin\\vite.js" --port 5173'), 'vite.js --port 5173');
  assert.equal(commandSummary('cmd.exe /c npm run dev'), '/c npm run dev');
  assert.equal(commandSummary('python.exe -m mcp_server_git --repository D:\\repo'), '-m mcp_server_git --repository repo');
  assert.equal(commandSummary(null), '');
});
