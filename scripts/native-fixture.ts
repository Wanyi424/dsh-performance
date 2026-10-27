// Runs as the Host inside tests/DesktopFixture.cs: checks the collector against a real Windows process tree.
import { spawn, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
import { Sampler } from '../src/collector';
import { HostProfiler } from '../src/profiler';
const [executable, ...ids] = process.argv.slice(2);
const [root, renderer, gpu, external] = ids.map(Number);
// A program the Host starts, which starts another: one tool program of two processes (plus any console host).
const shell = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1 >nul'], { windowsHide: true, stdio: 'ignore' });
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
// A stand-in plugin whose folder holds cmd.exe: the shell below must be charged to it by its executable's path.
const shellPath = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
const standIn = [{ id: 'stand-in-plugin', label: 'stand-in', version: '1', dir: dirname(shellPath) }];
// The Host's own profiler, as the plugin runs it: each fresh reading closes a window of this process's main thread.
const profiler = new HostProfiler(() => standIn); await profiler.start();
const sampler = new Sampler(executable, undefined, () => standIn, profiler);
try {
  await wait(800);
  const [a, b] = await Promise.all([sampler.sample(), sampler.sample()]);
  assert.equal(a, b, 'concurrent requests share the same sample');
  const kind = new Map(a.processes.map(p => [p.pid, p.kind]));
  assert.equal(kind.get(root), 'main'); assert.equal(kind.get(renderer), 'renderer'); assert.equal(kind.get(gpu), 'gpu');
  assert.equal(kind.get(process.pid), 'host'); assert.equal(kind.get(shell.pid!), 'tool');
  assert.match(a.processes.find(p => p.pid === shell.pid)!.detail ?? '', /ping -n 60/, 'tool command line is read');
  assert.equal(a.processes.find(p => p.pid === shell.pid)!.plugin, 'stand-in-plugin', 'a tool from a plugin folder belongs to that plugin');
  assert.equal(a.processes.find(p => p.pid === root)!.plugin, undefined, 'only tool processes are matched to plugins');
  assert.ok(a.processes.some(p => p.parent === shell.pid && p.kind === 'tool' && /^ping/i.test(p.name)), 'a grandchild of the Host is a tool process too');
  assert.ok(!kind.has(external), 'a same-named program outside the DSH tree is excluded');
  assert.ok(a.collector && !kind.has(a.collector.pid), 'the collector is reported apart from the totals');
  assert.equal(a.cpu, null); assert.ok(a.memory! > 0);
  assert.ok(a.system && a.system.memoryTotal > a.system.memoryUsed && a.system.memoryUsed > 0, 'machine memory is read');
  assert.ok(a.processes.every(p => p.threads > 0), 'thread counts are read');
  assert.equal(a.attribution!.error, null, 'the profiler runs in this Node');
  assert.equal(a.attribution!.state, 'running');
  assert.deepEqual(Object.keys(a.attribution!.cpu!), ['plugin:stand-in-plugin', 'core', 'gc', 'other'], 'profiling began before the first reading, which closes its first window');
  await wait(2100); const second = await sampler.sample();
  const owners = second.attribution!.cpu!;
  assert.deepEqual(Object.keys(owners), ['plugin:stand-in-plugin', 'core', 'gc', 'other'], 'the next reading splits the main thread by owner');
  assert.ok(Object.values(owners).every(v => Number.isFinite(v) && v >= 0) && Object.values(owners).reduce((x, y) => x + y, 0) <= 100 / second.cores + .01, 'shares of the machine, at most one core\'s worth');
  assert.equal(second.collector!.pid, a.collector!.pid); assert.equal(typeof second.cpu, 'number');
  assert.equal(typeof second.system!.cpu, 'number', 'machine CPU over the same interval');
  assert.ok(second.system!.cpu! >= second.cpu! - .5, 'the machine is at least as busy as DSH');
  await wait(16000);
  assert.throws(() => process.kill(second.collector!.pid, 0), 'idle collector exits');
  const resumed = await sampler.sample(); assert.notEqual(resumed.collector!.pid, second.collector!.pid); assert.equal(resumed.cpu, null);
  assert.equal(resumed.attribution!.state, 'running', 'the profiler remains active while the native collector is idle');
  assert.deepEqual(Object.keys(resumed.attribution!.cpu!), Object.keys(owners), 'the profiler timer keeps rotating windows without native readings');
  sampler.dispose(); await wait(150); assert.throws(() => process.kill(resumed.collector!.pid, 0));
  await assert.rejects(sampler.sample(), /关闭/);
  console.log(JSON.stringify({ scope: 'main, renderer, GPU, Host and a tool shell with its child; same-named outside program excluded', kinds: [...new Set(a.processes.map(p => p.kind))],
    pluginHelper: a.processes.find(p => p.pid === shell.pid)!.plugin,
    hostSplit: { owners, startPauseMs: a.attribution!.startPauseMs },
    machine: { cpu: second.system!.cpu, memoryUsedMB: Math.round(second.system!.memoryUsed / 1024 ** 2), memoryTotalMB: Math.round(second.system!.memoryTotal / 1024 ** 2) },
    cache: 'concurrent requests shared', idle: 'helper exited after 15 seconds', resume: 'new helper and fresh CPU baseline', dispose: 'helper exited', collectorMemory: second.collector!.memory }));
} finally { sampler.dispose(); profiler.dispose(); spawnSync('taskkill', ['/pid', String(shell.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); }
