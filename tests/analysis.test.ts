import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Analyzer } from '../src/analysis';

// The real V8 profilers, in this process: a fake plugin burns CPU and keeps memory while the analysis runs.
test('a real analysis charges a plugin\'s busy loop and retained memory to that plugin', { timeout: 20_000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-analysis-')), dir = join(profile, 'node_modules', 'dsh-busy');
  try {
    await mkdir(join(dir, 'lib'), { recursive: true });
    await writeFile(join(dir, 'lib', 'host.mjs'), `export const kept = [];
export function burn(ms) { const end = performance.now() + ms; let x = 0; while (performance.now() < end) x += Math.sqrt(x + 1); return x; }
export function hold(n) { for (let i = 0; i < n; i++) kept.push(new Array(256).fill(i)); }`);
    const plugin: { burn(ms: number): number; hold(n: number): void } = await import(pathToFileURL(join(dir, 'lib', 'host.mjs')).href);
    const analyzer = new Analyzer(async () => [{ id: 'dsh-busy', label: '忙碌插件', version: '1', dir }], join(profile, 'dsh-install'));
    const running = await analyzer.start(1);
    assert.equal(running.state, 'running');
    await assert.rejects(analyzer.start(1), /正在进行/);
    plugin.burn(300); plugin.hold(2000); plugin.burn(200);
    await analyzer.wait();
    const state = analyzer.status();
    assert.equal(state.state, 'done');
    if (state.state !== 'done') return;
    const busy = state.result.owners.find(o => o.id === 'plugin:dsh-busy')!;
    assert.ok(busy.cpuMs >= 350, `plugin CPU ${busy.cpuMs} ms`);
    assert.equal(busy.functions[0].name, 'burn'); assert.match(busy.functions[0].where, /^lib\/host\.mjs:2$/);
    assert.ok(busy.memory! > 1024 * 1024, `plugin memory ${busy.memory} bytes`);
    assert.ok(state.result.busyMs >= busy.cpuMs);
    // Cancelling keeps the previous result.
    await analyzer.start(10);
    assert.equal(analyzer.cancel().state, 'done'); await analyzer.wait();
  } finally { await rm(profile, { recursive: true, force: true }); }
});
