import test from 'node:test';
import assert from 'node:assert/strict';
import { Responsiveness, type Frame, type Interaction } from '../src/responsiveness';

test('stutters and interactions are event driven, recorded only while listening, and kept for one hour', () => {
  let now = 1000, frames!: (items: Frame[]) => void, interactions!: (items: Interaction[]) => void, connected = 0;
  const log = new Responsiveness({
    frames: accept => { connected++; frames = accept; return () => { connected--; }; },
    interactions: accept => { connected++; interactions = accept; return () => { connected--; }; },
  }, () => now);
  log.start(); log.start(); assert.equal(connected, 2);
  now = 2000;
  frames([{ time: 1500, duration: 100 }, { time: 1800, duration: 20 }, { time: 900, duration: 200 }]);
  // One click reports pointerdown, pointerup and click: one interaction, as slow as the slowest of them.
  interactions([{ id: 7, time: 1600, duration: 40, kind: 'pointer' }, { id: 7, time: 1600, duration: 120, kind: 'pointer' }]);
  interactions([{ id: 7, time: 1600, duration: 88, kind: 'pointer' }, { id: 8, time: 1900, duration: 24, kind: 'key' }]);
  assert.deepEqual(log.snapshot().frames, [{ time: 1500, duration: 100 }]);
  assert.deepEqual(log.snapshot().interactions.map(i => [i.id, i.duration]), [[7, 120], [8, 24]]);
  assert.deepEqual(log.snapshot().spans, [{ start: 1000, end: 2000 }]);
  log.stop(); assert.equal(connected, 0);
  now = 12_000; log.start(); now = 13_000; frames([{ time: 12_500, duration: 80 }]);
  assert.deepEqual(log.snapshot().spans, [{ start: 1000, end: 2000 }, { start: 12_000, end: 13_000 }]);
  now = 3_600_000 + 2_500;
  assert.deepEqual(log.snapshot().frames, [{ time: 12_500, duration: 80 }]);
  assert.deepEqual(log.snapshot().interactions, []);
  assert.deepEqual(log.snapshot().spans, [{ start: 12_000, end: now }]);
  log.stop(); assert.equal(connected, 0);
});

test('a missing or failing observer reports unsupported rather than a calm window', () => {
  const failing = new Responsiveness({ frames: () => { throw new Error('unsupported'); } }); failing.start();
  assert.deepEqual(failing.snapshot().supported, { frames: false, interactions: false }); assert.deepEqual(failing.snapshot().spans, []);
  assert.deepEqual(new Responsiveness({}).snapshot().supported, { frames: false, interactions: false });
  const partial = new Responsiveness({ interactions: () => () => {} }); partial.start();
  assert.deepEqual(partial.snapshot().supported, { frames: false, interactions: true });
});
