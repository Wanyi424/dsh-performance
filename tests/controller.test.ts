import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller';
import { Responsiveness } from '../src/responsiveness';
import type { Sample } from '../src/contracts';

class Doc extends EventTarget { hidden = false; hide(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')); } }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const quiet = () => new Responsiveness({});
function sample(time = Date.now()): Sample {
  return { time, intervalMs: 2000, cpu: 1, memory: 10, cores: 8, started: 0, unavailable: 0, collector: { pid: 2, cpu: 0, memory: 2 }, system: null, attribution: null,
    processes: [{ pid: 1, parent: 0, created: 0, name: 'DeepSeek Harness.exe', kind: 'main', group: 'app', threads: 1, detail: null, cpu: 1, memory: 10 }] };
}

test('the sidebar row and the page share one sampler; the page refreshes on open and samples faster', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let calls = 0; const c = new Controller(async () => { calls++; return sample(); }, new Doc(), quiet());
    const row = c.attach(); await flush(); assert.equal(calls, 1);
    mock.timers.tick(2_999); await flush(); assert.equal(calls, 1);
    mock.timers.tick(1); await flush(); assert.equal(calls, 2);
    const page = c.attach(true); await flush(); assert.equal(calls, 3);
    mock.timers.tick(2_000); await flush(); assert.equal(calls, 4);
    page(); mock.timers.tick(2_000); await flush(); assert.equal(calls, 5);
    mock.timers.tick(2_000); await flush(); assert.equal(calls, 5);
    row(); mock.timers.tick(60_000); await flush(); assert.equal(calls, 5);
    c.dispose();
  } finally { mock.timers.reset(); }
});

test('a hidden window stops sampling and drops an answer that arrives after hiding', async () => {
  const doc = new Doc(); let resolve!: (s: Sample) => void, calls = 0;
  const c = new Controller(() => { calls++; return new Promise(r => { resolve = r; }); }, doc, quiet());
  const detach = c.attach(); doc.hide(true); resolve(sample()); await flush();
  assert.equal(c.snapshot().sample, undefined); assert.equal(c.snapshot().hidden, true);
  c.retry(); await flush(); assert.equal(calls, 1);
  doc.hide(false); await flush(); assert.equal(calls, 2);
  detach(); c.dispose();
});

test('a failure keeps the last reading, backs off to 15 s, and clears on the next success', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let fail = false, calls = 0;
    const c = new Controller(async () => { calls++; if (fail) throw new Error('采集超时'); return sample(); }, new Doc(), quiet());
    const stop = c.attach(); await flush();
    fail = true; c.retry(); await flush();
    assert.equal(c.snapshot().error, '采集超时'); assert.ok(c.snapshot().sample);
    mock.timers.tick(14_999); await flush(); assert.equal(calls, 2);
    fail = false; mock.timers.tick(1); await flush(); assert.equal(calls, 3); assert.equal(c.snapshot().error, '');
    stop(); c.dispose();
  } finally { mock.timers.reset(); }
});

test('history keeps one hour of points and never repeats a reading', async () => {
  let time = 0, same = false; const c = new Controller(async () => sample(same ? time : time += 3_000), new Doc(), quiet());
  const stop = c.attach(); await flush();
  for (let i = 0; i < 1300; i++) { c.retry(); await flush(); }
  const points = c.snapshot().points;
  assert.equal(points.at(-1)!.time - points[0].time, 3_600_000 - 3_000);
  same = true; c.retry(); await flush(); assert.equal(c.snapshot().points.length, points.length);
  stop(); c.dispose();
});
