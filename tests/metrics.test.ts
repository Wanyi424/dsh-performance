import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { calculate, classify, pluginOf } from '../src/metrics';
import { createHandler } from '../src/host';
import type { RawProcess, RawSample } from '../src/contracts';

const row = (pid: number, parent: number, role: RawProcess['role'], cpuMs: number, memory: number | null, extra: Partial<RawProcess> = {}): RawProcess =>
  ({ pid, parent, role, name: 'DeepSeek Harness.exe', threads: 4, type: null, subtype: null, command: null, created: 100, cpuMs, memory, ...extra });
/** The real tree: main, Electron children, the Host in Node mode and a shell it started. */
export function raw(time = 10_000): RawSample {
  // The machine: 8 cores, idle for a quarter of every millisecond of core time; 16 GB with 10 GB available.
  const system = { idleMs: time * 8 / 4, kernelMs: time * 8 / 2, userMs: time * 8 / 2, memoryTotal: 16 * 1024 ** 3, memoryAvailable: 10 * 1024 ** 3 };
  return { time, monotonic: time, cores: 8, collectionMs: 2, unavailable: 0, system,
    processes: [
      row(10, 1, 'main', time / 2, 20),
      row(11, 10, 'app', time / 4, 30, { type: 'renderer' }),
      row(12, 10, 'app', 0, 10, { type: 'utility', subtype: 'network.mojom.NetworkService' }),
      row(13, 10, 'host', time / 4, 40),
      row(14, 13, 'tool', 0, 5, { name: 'pwsh.exe', command: 'pwsh.exe -NoLogo' }),
    ], collector: row(15, 13, 'tool', time / 100, 4, { name: 'collector.exe' }) };
}

test('processes are classified by their place in the tree and their Electron type', () => {
  assert.deepEqual(classify({ role: 'main', type: null, subtype: null }), { kind: 'main', group: 'app' });
  assert.deepEqual(classify({ role: 'app', type: 'renderer', subtype: null }), { kind: 'renderer', group: 'ui' });
  assert.deepEqual(classify({ role: 'app', type: 'gpu-process', subtype: null }), { kind: 'gpu', group: 'gpu' });
  assert.deepEqual(classify({ role: 'app', type: 'utility', subtype: 'network.mojom.NetworkService' }), { kind: 'network', group: 'app' });
  assert.deepEqual(classify({ role: 'app', type: 'utility', subtype: 'video_capture.mojom.VideoCaptureService' }), { kind: 'utility', group: 'app' });
  assert.deepEqual(classify({ role: 'app', type: null, subtype: null }), { kind: 'other', group: 'app' });
  assert.deepEqual(classify({ role: 'host', type: null, subtype: null }), { kind: 'host', group: 'host' });
  assert.deepEqual(classify({ role: 'tool', type: null, subtype: null }), { kind: 'tool', group: 'tools' });
});

test('CPU is normalized to the whole machine; totals include tool processes but not the collector', () => {
  const s = calculate(raw(12_000), raw());
  // (1000 + 500 + 500) ms of CPU over 2000 ms on 8 cores.
  assert.equal(s.cpu, 12.5); assert.equal(s.memory, 105); assert.equal(s.intervalMs, 2000);
  assert.equal(s.collector!.memory, 4); assert.equal(s.collector!.cpu, .125);
  assert.equal(s.started, 100);
  assert.deepEqual(s.processes.map(p => p.group), ['app', 'ui', 'app', 'host', 'tools']);
  assert.equal(s.processes[4].detail, 'pwsh.exe -NoLogo'); assert.equal(s.processes[2].detail, 'network.mojom.NetworkService');
});

test('a process started inside the interval counts all its CPU time; a reused PID or an unseen old process does not invent any', () => {
  const next = raw(12_000);
  next.processes.push(row(16, 14, 'tool', 400, 8, { name: 'node.exe', created: 11_000 }));
  next.processes.push(row(17, 14, 'tool', 900, 8, { name: 'git.exe', created: 50 }));
  next.processes[1] = { ...next.processes[1], created: 9_000 };
  const s = calculate(next, raw());
  assert.equal(s.processes.find(p => p.pid === 16)!.cpu, 2.5);
  assert.equal(s.processes.find(p => p.pid === 17)!.cpu, null);
  assert.equal(s.processes.find(p => p.pid === 11)!.cpu, null);
  // main 1000 ms and Host 500 ms of the old processes, plus the new one; the two unknowns add nothing.
  assert.equal(s.cpu, 6.25 + 3.125 + 2.5);
});

test('first sample, long gap and restarted helper have no CPU reading rather than zero', () => {
  assert.equal(calculate(raw()).cpu, null); assert.equal(calculate(raw()).intervalMs, null);
  assert.equal(calculate(raw(30_000), raw()).cpu, null);
  const restarted = raw(12_000); restarted.monotonic = 30;
  assert.equal(calculate(restarted, raw()).cpu, null);
  assert.equal(calculate(restarted, raw()).memory, 105);
});

test('memory sums what Windows reports, and is unavailable only when nothing is reported', () => {
  const partial = raw(); partial.processes[4].memory = null;
  assert.equal(calculate(partial).memory, 100);
  const none = raw(); none.processes.forEach(p => { p.memory = null; });
  assert.equal(calculate(none).memory, null);
});

test('a tool process whose executable ships inside a plugin is that plugin\'s', () => {
  const plugins = [{ id: 'dsh-ocr', dir: join('/profile', 'node_modules', 'dsh-ocr') }];
  const next = raw(); next.processes[4] = { ...next.processes[4], image: join('/profile', 'node_modules', 'dsh-ocr', 'bin', 'ocr.exe') };
  assert.equal(calculate(next, undefined, plugins).processes[4].plugin, 'dsh-ocr');
  assert.equal(calculate(raw(), undefined, plugins).processes[4].plugin, null);
  assert.equal(calculate(next).processes[0].plugin, undefined);
  assert.equal(pluginOf(join('/profile', 'node_modules', 'dsh-ocr-extra', 'x.exe'), plugins), null, 'a sibling folder with the same prefix is not the plugin');
});

test('Host API only accepts fixed actions, never client-selected PIDs or commands', async () => {
  let calls = 0; const handle = createHandler({ sampler: { async sample() { calls++; return calculate(raw()); } } });
  const request = (body: unknown) => new Request('http://localhost/api/dsh-performance', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await handle(request({ action: 'kill', pid: 10 }))).status, 400); assert.equal(calls, 0);
  const response = await handle(request({ action: 'sample', pid: 123, command: 'anything' }));
  assert.equal(response.status, 200); assert.equal((await response.json()).data.processes.length, 5); assert.equal(calls, 1);
  const failed = createHandler({ sampler: { async sample() { throw new Error('采集不可用'); } } });
  assert.match(await (await failed(request({ action: 'sample' }))).text(), /采集不可用/);
});

test('profiling is an explicit opt-in action and never accepts arbitrary commands', async () => {
  const calls: boolean[] = [];
  const handle = createHandler({ sampler: { async sample() { return calculate(raw()); } }, profiler: {
    async enable() { calls.push(true); }, disable() { calls.push(false); }, detail() { return { cpu: [], memory: [], memoryAt: null }; },
  } });
  const post = (body: unknown) => handle(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }));
  assert.equal((await post({ action: 'profiling', enabled: true })).status, 200);
  assert.equal((await post({ action: 'profiling', enabled: false })).status, 200);
  assert.deepEqual(calls, [true, false]);
  assert.equal((await post({ action: 'profiling', enabled: 'yes' })).status, 400);
});

test('the machine share comes from the same interval: busy CPU and physical memory in use', () => {
  const s = calculate(raw(12_000), raw());
  assert.equal(s.system!.cpu, 75); assert.equal(s.system!.memoryUsed, 6 * 1024 ** 3); assert.equal(s.system!.memoryTotal, 16 * 1024 ** 3);
  assert.equal(calculate(raw()).system!.cpu, null);
  assert.equal(calculate({ ...raw(12_000), system: null }, raw()).system, null);
  assert.equal(s.processes[0].threads, 4);
});

test('the owner query takes an id and a range only; the plugin list carries no paths', async () => {
  const asked: unknown[][] = [];
  const profiler = { detail(id: string, from: number, to: number) { asked.push([id, from, to]); return { cpu: [{ name: 'render', where: 'lib/host.js:4', value: 12 }], memory: [], memoryAt: null }; } };
  const catalog = { async list() { return [{ id: 'dsh-a', label: 'A', version: '1.0.0', dir: '/secret/path' }]; } };
  const handle = createHandler({ sampler: { async sample() { return calculate(raw()); } }, profiler, catalog });
  const post = async (body: unknown) => { const r = await handle(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  assert.equal((await post({ action: 'owner', id: 'plugin:dsh-a', from: 'yesterday', to: 1 })).status, 400);
  assert.equal((await post({ action: 'owner', id: { pid: 1 }, from: 0, to: 1 })).status, 400);
  assert.equal((await post({ action: 'owner', id: 'plugin:dsh-a', from: 0, to: 60_000 })).body.data.cpu[0].name, 'render');
  assert.deepEqual(asked, [['plugin:dsh-a', 0, 60_000]]);
  assert.deepEqual((await post({ action: 'plugins' })).body.data, [{ id: 'dsh-a', label: 'A', version: '1.0.0' }]);
  assert.equal((await post({ action: 'analyze', seconds: 30 })).status, 400, 'the on-demand analysis is gone');
});
