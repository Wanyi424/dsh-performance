import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdown, idle, visibleKeys } from '../src/breakdown';
import { pointOf } from '../src/insights';
import { report } from '../src/report';
import { Tracker } from '../src/tracking';
import { assess } from '../src/verdict';
import type { Attribution, Point, ProcessMetric, Sample } from '../src/contracts';

const MB = 1024 ** 2;
const PLUGINS = [{ id: 'dsh-notes', label: '笔记', version: '1.0.0' }, { id: 'dsh-context', label: '上下文', version: '0.7.0' }, { id: 'dsh-performance', label: 'DSH 性能监控', version: '0.7.0' },
  { id: 'dsh-theme', label: '主题', version: '0.1.0' }];
const proc = (pid: number, parent: number, kind: ProcessMetric['kind'], group: ProcessMetric['group'], cpu: number, memory: number, extra: Partial<ProcessMetric> = {}): ProcessMetric =>
  ({ pid, parent, created: pid, name: 'DeepSeek Harness.exe', kind, group, threads: 4, detail: null, cpu, memory: memory * MB, ...extra });
const split = (time: number): Attribution => ({
  cpu: { 'plugin:dsh-notes': 1, 'plugin:dsh-context': .5, 'plugin:dsh-performance': .1, core: 1.4, gc: .2, other: .1 },
  memory: { at: time, owners: { 'plugin:dsh-notes': 6 * MB, 'plugin:dsh-context': 3 * MB, 'plugin:dsh-performance': MB, core: 40 * MB, gc: 0, other: 5 * MB }, pauseMs: 60 },
  state: 'running', since: 0, startPauseMs: 250, error: null,
});
/** A minute of readings: DSH's parts, a plugin's helper program, and `git status` run twice; the Host split on every reading. */
function minute(attribution: (time: number) => Attribution | null = split) {
  const tracker = new Tracker(), points: Point[] = [];
  let last!: Sample;
  for (let time = 2000; time <= 60_000; time += 2000) {
    const git = time === 10_000 || time === 12_000 ? 31 : time === 30_000 || time === 32_000 ? 32 : 0;
    const processes = [
      proc(10, 1, 'main', 'app', .2, 90), proc(11, 10, 'network', 'app', .1, 8, { detail: 'network.mojom.NetworkService' }),
      proc(12, 10, 'renderer', 'ui', 2, 300), proc(13, 10, 'gpu', 'gpu', .5, 80), proc(14, 10, 'host', 'host', 4, 170),
      proc(20, 14, 'tool', 'tools', 1, 40, { name: 'context-indexer.exe', detail: '"C:\\Users\\me\\.dsh\\node_modules\\dsh-context\\bin\\context-indexer.exe" --watch', plugin: 'dsh-context', path: 'C:\\Users\\me\\.dsh\\node_modules\\dsh-context\\bin\\context-indexer.exe' }),
      ...git ? [proc(git, 14, 'tool', 'tools', 3, 12, { name: 'git.exe', detail: 'git.exe status --porcelain' })] : [],
    ];
    last = { time, intervalMs: 2000, cores: 8, started: 0, cpu: processes.reduce((a, p) => a + p.cpu!, 0), memory: processes.reduce((a, p) => a + p.memory!, 0),
      system: { cpu: 30, memoryUsed: 8 * 1024 ** 3, memoryTotal: 16 * 1024 ** 3 }, processes, collector: { pid: 99, cpu: .05, memory: 5 * MB }, unavailable: 0, attribution: attribution(time) };
    tracker.record(last); points.push(pointOf(last));
  }
  return { sample: last, points, tracked: tracker.snapshot() };
}

test('DSH is listed by part, busiest first; a part with several processes opens into them', () => {
  const { sample, points, tracked } = minute(), data = breakdown({ sample, points, tracked, plugins: PLUGINS, start: 0, end: 60_000, sort: 'cpu' });
  assert.deepEqual(data.dsh.map(r => r.key), ['group:host', 'group:ui', 'group:gpu', 'group:app']);
  const app = data.dsh.find(r => r.key === 'group:app')!;
  assert.equal(app.memory, 98 * MB); assert.deepEqual(app.children!.map(r => r.name), ['主进程', '网络服务']);
  assert.equal(app.note, '窗口管理、联网与存储 · 2 个进程', 'a part that opens says how many lines it opens into');
  assert.equal(app.children![1].note, '模型请求与联网');
  assert.equal(data.dsh.find(r => r.key === 'group:ui')!.children, undefined, 'one process: nothing to open');
  assert.deepEqual(breakdown({ sample, points, tracked, plugins: PLUGINS, start: 0, end: 60_000, sort: 'memory' }).dsh.map(r => r.key), ['group:ui', 'group:host', 'group:app', 'group:gpu']);
});

test('the Host opens into every plugin, then DSH itself and「其他」under a heading of their own; the lines add up to the Host, idle ones greyed, not folded', () => {
  const { sample, points, tracked } = minute(), data = breakdown({ sample, points, tracked, plugins: PLUGINS, start: 0, end: 60_000, sort: 'cpu' }), host = data.dsh[0];
  assert.deepEqual(host.children!.map(r => r.name), ['笔记', '上下文', 'DSH 性能监控', '主题', 'DSH 自身', '其他']);
  const total = host.children!.reduce((a, r) => a + r.cpu!, 0);
  assert.ok(Math.abs(total - host.cpu!) < 1e-9, `${total} vs ${host.cpu}`);
  assert.ok(Math.abs(host.children!.at(-1)!.cpu! - 1) < 1e-9, '「其他」is garbage collection, other code and the rest');
  assert.equal(host.children![0].memory, 6 * MB, 'a plugin\'s memory is its latest reading');
  assert.equal(host.note, '运行 Agent、会话和插件 · 4 个插件');
  assert.deepEqual(host.children!.map(r => r.heading), ['插件', '插件', '插件', '插件', '不属于插件', '不属于插件']);
  // A plugin is noted by its package and version; this one is tagged as such.
  assert.equal(host.children![1].note, 'dsh-context · v0.7.0 · 自带 1 个程序');
  assert.equal(host.children![2].note, 'dsh-performance · v0.7.0 · 自带 1 个程序', 'the collector is this plugin\'s helper');
  assert.equal(host.children![2].tag, '本插件');
  // A plugin that used nothing is listed with the rest, only greyed, so the drawer's up and down reach it as soon as the Host is open.
  assert.deepEqual(host.children!.filter(idle).map(r => r.name), ['主题']);
  assert.deepEqual(visibleKeys(data, new Set([host.key]), false).slice(0, 7),
    ['group:host', 'owner:plugin:dsh-notes', 'owner:plugin:dsh-context', 'owner:plugin:dsh-performance', 'owner:plugin:dsh-theme', 'owner:core', 'owner:misc']);
});

test('without a split in the range the plugins are unknown, not idle, and the rest is all of the Host', () => {
  const { sample, points, tracked } = minute(() => null), host = breakdown({ sample, points, tracked, plugins: PLUGINS, start: 0, end: 60_000, sort: 'cpu' }).dsh[0];
  assert.equal(host.children![0].cpu, null);
  assert.equal(host.children!.at(-1)!.cpu, host.cpu);
});

test('programs DSH started carry their plugin; ended runs of one command merge into one line', () => {
  const { sample, points, tracked } = minute(), data = breakdown({ sample, points, tracked, plugins: PLUGINS, start: 0, end: 60_000, sort: 'cpu' });
  assert.equal(data.programs.length, 1);
  assert.equal(data.programs[0].name, 'context-indexer'); assert.equal(data.programs[0].tag, '上下文'); assert.equal(data.programs[0].note, '--watch');
  assert.equal(data.endedCount, 2); assert.equal(data.ended.length, 1);
  assert.equal(data.ended[0].name, 'Git（status） × 2'); assert.equal(data.ended[0].key, '32:32', 'it opens the latest run'); assert.equal(data.ended[0].memory, 12 * MB);
  assert.deepEqual(data.ended[0].runs!.map(r => r.key), ['32:32', '31:31'], 'every run, newest first');
});

test('the report reads like the page, by name only: no command lines or paths', () => {
  const { sample, points, tracked } = minute(), data = breakdown({ sample, points, tracked, plugins: PLUGINS, start: 0, end: 60_000, sort: 'cpu' });
  const response = { frames: [{ time: 59_000, duration: 120 }], interactions: [], spans: [{ start: 0, end: 60_000 }], supported: { frames: true, interactions: true } };
  const text = report({ now: 60_000, rangeMs: 900_000, rangeLabel: '15 分钟', sample, points, response, verdict: assess(points, sample, response.frames, 60_000), rows: data, plugins: PLUGINS });
  assert.match(text, /^# DSH 性能监控报告\n/);
  assert.match(text, /- 结论：DSH 运行正常。没有发现占用过高、内存上涨或界面卡顿。\n/);
  assert.match(text, /\| 后台 \| 4\.0% \| 170 MB \|/); assert.match(text, /\| └ 笔记 \| 1\.0% \| 6 MB \|/);
  assert.match(text, /\| context-indexer（插件：上下文） \| 1\.0% \| 40 MB \|/);
  assert.match(text, /已退出：Git（status） × 2/); assert.match(text, /- 卡顿 1 次，最长 120 毫秒/);
  assert.match(text, /由 DSH 性能监控 v0\.7\.0 生成/);
  assert.doesNotMatch(text, /--watch|--porcelain|C:\\|node_modules/, 'no command lines or paths');
});
