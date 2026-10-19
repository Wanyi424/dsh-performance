import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HostProfiler } from '../src/profiler';
import { PROFILER, type Attribution } from '../src/contracts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Busy = { burn(ms: number): number; hold(n: number): void; chatter(n: number): void };
/** A fake plugin installed in a temporary profile: it burns CPU, keeps memory, and logs memory it does not keep. */
async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-profiler-')), dir = join(profile, 'node_modules', 'dsh-busy');
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'lib', 'host.mjs'), `export const kept = [];
export function burn(ms) { const end = performance.now() + ms; let x = 0; while (performance.now() < end) x += Math.sqrt(x + 1); return x; }
export function hold(n) { for (let i = 0; i < n; i++) kept.push(new Array(256).fill(i)); }
export function chatter(n) { for (let i = 0; i < n; i++) console.log('%c', new Array(1_000_000).fill(i)); }`);
  const plugin: Busy = await import(pathToFileURL(join(dir, 'lib', 'host.mjs')).href);
  return { profile, plugin, plugins: [{ id: 'dsh-busy', label: '忙碌插件', version: '1', dir }] };
}

// The real V8 profilers, in this process, as the Host runs them.
test('profiling runs from the start: every reading closes a window charged to plugins, and memory is read when due', { timeout: 30_000 }, async () => {
  const { profile, plugin, plugins } = await fixture();
  let now = 1_000_000;
  const profiler = new HostProfiler(() => plugins, join(profile, 'dsh-install'), () => now);
  await profiler.start();
  try {
    const status = profiler.status();
    assert.equal(status.state, 'running'); assert.equal(status.since, now); assert.ok(status.startPauseMs! >= 0); assert.equal(status.error, null);
    plugin.burn(300);
    const first = profiler.take(1);
    assert.deepEqual(Object.keys(first.cpu!), ['plugin:dsh-busy', 'core', 'gc', 'other'], 'the first reading already closes a window: profiling began with the Host');
    assert.ok(first.cpu!['plugin:dsh-busy'] > 50, `the plugin had most of the window: ${first.cpu!['plugin:dsh-busy']}%`);
    const detail = profiler.detail('plugin:dsh-busy', now - 60_000, now);
    // Loose bounds: under a loaded machine the sampler thread can be late, and the gap goes to the frame before it.
    assert.equal(detail.cpu[0].name, 'burn'); assert.match(detail.cpu[0].where, /^lib\/host\.mjs:2$/); assert.ok(detail.cpu[0].value >= 150, `burn ${detail.cpu[0].value} ms`);
    assert.deepEqual(profiler.detail('plugin:dsh-busy', now + 120_000, now + 180_000).cpu, [], 'nothing outside the range');
    assert.equal(profiler.take(1).memory, null, 'memory is first read a minute after the profiler starts');

    // ~4 MB kept by the plugin, and ~16 MB it only logs: while connected, V8 keeps console arguments for the inspector, and
    // they are neither the plugin's nor allowed to stay.
    plugin.hold(2000); plugin.chatter(2);
    now += PROFILER.firstMemoryMs;
    let memory: Attribution['memory'] = null;
    for (let i = 0; i < 100 && !memory; i++) { await sleep(20); memory = profiler.take(1).memory; }
    assert.ok(memory, 'memory was read');
    const held = memory.owners['plugin:dsh-busy'];
    assert.ok(held > 1024 ** 2 && held < 12 * 1024 ** 2, `plugin memory ${held} bytes`);
    assert.equal(profiler.detail('plugin:dsh-busy', 0, now).memory[0].name, 'hold');
    assert.equal(memory.at, now); assert.ok(memory.pauseMs >= 0);
  } finally { profiler.dispose(); await rm(profile, { recursive: true, force: true }); }
  assert.equal(profiler.take(1).cpu, null, 'no windows after dispose');
  assert.equal(profiler.status().state, 'paused');
});

test('with no readings, windows close on their own; a pause stops the profiler, keeps what it recorded, and resuming starts it again', { timeout: 20_000 }, async () => {
  const { profile, plugin, plugins } = await fixture();
  let now = 1_000_000;
  // The timer that closes windows while no readings come is mocked; the clock it reads is the profiler's own.
  mock.timers.enable({ apis: ['setInterval'] });
  const profiler = new HostProfiler(() => plugins, join(profile, 'dsh-install'), () => now);
  try {
    await profiler.start();
    plugin.burn(80);
    now += PROFILER.windowMs; mock.timers.tick(PROFILER.windowMs / 2);
    assert.ok(profiler.detail('plugin:dsh-busy', 0, now).cpu[0]?.value >= 30, 'the timer closed the window and recorded where the time went');
    assert.ok(profiler.take(1).cpu, 'a reading still gets its own window');

    profiler.pause();
    assert.equal(profiler.status().state, 'paused');
    assert.equal(profiler.take(1).cpu, null, 'paused: no split');
    assert.ok(profiler.detail('plugin:dsh-busy', 0, now).cpu.length, 'what was recorded stays viewable');
    await profiler.start();
    assert.equal(profiler.status().state, 'running'); assert.equal(profiler.status().since, now);
    plugin.burn(40);
    assert.ok(profiler.take(1).cpu!['plugin:dsh-busy'] > 0, 'resumed: readings are split again');
  } finally { mock.timers.reset(); profiler.dispose(); await rm(profile, { recursive: true, force: true }); }
});
