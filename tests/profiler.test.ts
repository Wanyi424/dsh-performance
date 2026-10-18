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
test('each reading closes a window that charges the Host\'s main thread to plugins, and memory is read when due', { timeout: 30_000 }, async () => {
  const { profile, plugin, plugins } = await fixture();
  let now = 1_000_000;
  const profiler = new HostProfiler(() => plugins, join(profile, 'dsh-install'), () => now);
  await profiler.start();
  try {
    const first = profiler.take(1);
    assert.equal(first.cpu, null, 'the first reading opens the first window'); assert.ok(first.startPauseMs! >= 0); assert.equal(first.error, null);
    plugin.burn(300);
    const second = profiler.take(1);
    assert.deepEqual(Object.keys(second.cpu!), ['plugin:dsh-busy', 'core', 'gc', 'other']);
    assert.ok(second.cpu!['plugin:dsh-busy'] > 50, `the plugin had most of the window: ${second.cpu!['plugin:dsh-busy']}%`);
    const detail = profiler.detail('plugin:dsh-busy', now - 60_000, now);
    // Loose bounds: under a loaded machine the sampler thread can be late, and the gap goes to the frame before it.
    assert.equal(detail.cpu[0].name, 'burn'); assert.match(detail.cpu[0].where, /^lib\/host\.mjs:2$/); assert.ok(detail.cpu[0].value >= 150, `burn ${detail.cpu[0].value} ms`);
    assert.deepEqual(profiler.detail('plugin:dsh-busy', now + 120_000, now + 180_000).cpu, [], 'nothing outside the range');
    assert.equal(profiler.take(1).memory, null, 'memory is first read a minute after start');

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
});

test('with no readings for a while the profiler stops, and the next reading starts it again', { timeout: 20_000 }, async () => {
  const { profile, plugins } = await fixture();
  const profiler = new HostProfiler(() => plugins, join(profile, 'dsh-install'));
  await profiler.start();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // Timers are mocked here, so the pause between readings is spent busy.
    const pause = () => { const end = performance.now() + 20; while (performance.now() < end) { /* busy */ } };
    profiler.take(4); pause();
    assert.ok(profiler.take(4).cpu, 'running: a reading closes a window');
    mock.timers.tick(PROFILER.lingerMs);
    assert.equal(profiler.take(4).cpu, null, 'stopped: the reading after a long pause starts a new first window');
    pause(); assert.ok(profiler.take(4).cpu);
  } finally { mock.timers.reset(); profiler.dispose(); await rm(profile, { recursive: true, force: true }); }
});
