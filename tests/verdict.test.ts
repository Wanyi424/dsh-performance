import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, assess, topUser } from '../src/verdict';
import type { Point, ProcessMetric, Sample } from '../src/contracts';
import type { Frame } from '../src/responsiveness';

const MB = 1024 ** 2, GB = 1024 ** 3, NOW = 10_000_000;
const proc = (pid: number, group: ProcessMetric['group'], cpu: number | null, memory: number, extra: Partial<ProcessMetric> = {}): ProcessMetric =>
  ({ pid, parent: 1, created: pid, name: 'DeepSeek Harness.exe', kind: group === 'tools' ? 'tool' : group === 'host' ? 'host' : 'renderer', group, threads: 4, detail: null, cpu, memory, ...extra });
/** A reading every 2 s over the last `ms`, DSH's CPU in the Host and the machine's beside it; memory per part in MB. */
function history(ms: number, host: number, machine: number | null = null, memory = (_t: number) => [200, 100, 100, 200, 0]): Point[] {
  const points: Point[] = [];
  for (let t = NOW - ms; t <= NOW; t += 2000) points.push({ time: t, intervalMs: 2000, cpu: [0, 0, 0, host, 0], memory: memory(t).map(v => v * MB), systemCpu: machine, systemMemory: null, owners: null });
  return points;
}
function sample(processes: ProcessMetric[], system: Sample['system'] = { cpu: 20, memoryUsed: 8 * GB, memoryTotal: 16 * GB }): Sample {
  const cpus = processes.flatMap(p => p.cpu === null ? [] : [p.cpu]);
  return { time: NOW, intervalMs: 2000, cores: 8, started: 0, cpu: cpus.reduce((a, b) => a + b, 0), memory: processes.reduce((a, p) => a + (p.memory ?? 0), 0), system, processes, collector: null, unavailable: 0, attribution: null };
}
const quiet = sample([proc(2, 'ui', 1, 300 * MB), proc(3, 'host', 1, 200 * MB)]);

test('a quiet DSH is reported as normal, with its figures', () => {
  const v = assess(history(120_000, 2, 20), quiet, [], NOW)!;
  assert.equal(v.level, 'ok'); assert.equal(v.title, 'DSH 运行正常'); assert.equal(v.detail, '没有发现占用过高、内存上涨或界面卡顿');
  assert.equal(assess([], undefined, [], NOW), null, 'nothing to say before the first reading');
});

test('DSH working is news, sustained heavy use is a warning, and each names the biggest user', () => {
  const busy = sample([proc(2, 'ui', 1, 300 * MB), proc(3, 'host', 2, 200 * MB), proc(9, 'tools', 17, 400 * MB, { name: 'node.exe', detail: 'node.exe vite.js --port 5173' })]);
  const news = assess(history(40_000, RULES.busy.cpu + 5), busy, [], NOW)!;
  assert.equal(news.level, 'info'); assert.equal(news.title, 'DSH 正在忙');
  assert.match(news.detail, /其中 Node\.js（vite\.js）占 17%/); assert.equal(news.subject, '9:9', 'the conclusion opens the program');
  const heavy = assess(history(70_000, RULES.high.cpu + 5), busy, [], NOW)!;
  assert.equal(heavy.level, 'warn'); assert.equal(heavy.title, 'DSH 占用很高');
  assert.ok(!heavy.findings.some(f => f.id === 'busy'), 'heavy use is not also reported as busy');
  assert.equal(assess(history(10_000, 90), busy, [], NOW)!.level, 'ok', 'ten seconds is not sustained');
});

test('a busy machine with little DSH in it says so, so DSH is not blamed', () => {
  const v = assess(history(40_000, 5, 90), quiet, [], NOW)!;
  assert.equal(v.level, 'info'); assert.equal(v.title, '电脑很忙，但主要不是 DSH'); assert.match(v.detail, /整机 CPU 90%，DSH 只占 5\.0%/);
});

test('stutters warn when frequent or long, and only recent ones count', () => {
  const frame = (ago: number, duration = 80): Frame => ({ time: NOW - ago, duration });
  assert.equal(assess(history(60_000, 1), quiet, [frame(60_000), frame(30_000), frame(1_000)], NOW)!.title, '界面出现卡顿');
  assert.match(assess(history(60_000, 1), quiet, [frame(1_000, 1_200)], NOW)!.detail, /最长 1\.2 秒/);
  assert.equal(assess(history(60_000, 1), quiet, [frame(400_000), frame(350_000), frame(1_000)], NOW)!.level, 'ok');
  assert.equal(assess(history(60_000, 1), quiet, [frame(400_000), frame(350_000), frame(1_000)], NOW)!.subject, undefined);
});

test('memory growing over half an hour warns and names the part that grew; too little history is not judged', () => {
  // The interface grows 15 MB a minute: 435 MB over 29 minutes.
  const growing = (t: number) => [200 + (t - (NOW - 1_740_000)) / 60_000 * 15, 100, 100, 200, 0];
  const v = assess(history(1_740_000, 1, null, growing), quiet, [], NOW)!;
  assert.equal(v.title, 'DSH 内存持续上涨'); assert.equal(v.subject, 'group:ui'); assert.match(v.detail, /主要来自界面/);
  assert.equal(assess(history(900_000, 1, null, growing), quiet, [], NOW)!.level, 'ok', 'fifteen minutes is too short to call it growth');
  // A dev server DSH started ten minutes ago: a step in the programs, not DSH growing.
  const launched = (t: number) => [200, 100, 100, 200, t > NOW - 600_000 ? 500 : 0];
  assert.equal(assess(history(1_740_000, 1, null, launched), quiet, [], NOW)!.level, 'ok');
});

test('a machine short of memory warns when DSH holds a large part of it', () => {
  const big = sample([proc(2, 'ui', 1, 4 * GB), proc(3, 'host', 1, 1.5 * GB)], { cpu: 20, memoryUsed: 15 * GB, memoryTotal: 16 * GB });
  const v = assess(history(60_000, 2), big, [], NOW)!;
  assert.equal(v.title, '电脑内存紧张'); assert.equal(v.subject, 'group:ui'); assert.match(v.detail, /整机已用 94% 的内存，其中 DSH 占 5\.50 GB/);
  assert.equal(assess(history(60_000, 2), sample(big.processes.slice(1), big.system), [], NOW)!.level, 'ok', 'a full machine is not DSH\'s doing when it holds little');
});

test('the biggest user is a part of DSH or one program, whichever uses more', () => {
  assert.deepEqual(topUser(quiet), { key: 'group:ui', name: '界面', cpu: 1 });
  assert.equal(topUser(sample([proc(2, 'ui', null, 1)])), null);
});
