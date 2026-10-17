import { HISTORY_MS } from './contracts';

/** A frame whose rendering was held up for at least 50 ms; `time` is when it started, epoch ms. */
export interface Frame { time: number; duration: number }
/** One click, tap or key press, from the input to the next frame painted after it. */
export interface Interaction { id: number; time: number; duration: number; kind: 'pointer' | 'key' }
export interface Span { start: number; end: number }
export interface ResponseLog { frames: Frame[]; interactions: Interaction[]; spans: Span[]; supported: { frames: boolean; interactions: boolean } }
type Observe<T> = (accept: (items: T[]) => void) => (() => void);
export interface Observers { frames?: Observe<Frame>; interactions?: Observe<Interaction> }

const POINTER = new Set(['pointerdown', 'pointerup', 'click', 'mousedown', 'mouseup']), KEY = new Set(['keydown', 'keyup', 'keypress']);
/**
 * Entries are placed on the wall clock the trend uses: the batch's latest entry ended about now, and the others are placed by
 * their distance from it. `timeOrigin + startTime` would drift from Date.now in a window open for days (system sleep, clock
 * changes), and the stutters would no longer line up with the readings.
 */
function observe<T>(type: string, map: (e: PerformanceEntry, time: number) => T | null, init: Record<string, unknown> = {}): Observe<T> {
  return accept => {
    const observer = new PerformanceObserver(list => {
      const entries = list.getEntries(), now = Date.now(), end = Math.max(...entries.map(e => e.startTime + e.duration));
      const items = entries.flatMap(e => { const item = map(e, now - (end - e.startTime)); return item ? [item] : []; });
      if (items.length) accept(items);
    });
    observer.observe({ type, ...init } as PerformanceObserverInit);
    return () => observer.disconnect();
  };
}
/**
 * Long animation frames count the rendering a slow frame held up, not only the script tasks; long tasks are the fallback.
 * Event timing reports interactions slower than 16 ms, the shortest threshold browsers allow.
 */
export function browserObservers(): Observers {
  if (typeof PerformanceObserver === 'undefined') return {};
  const types = PerformanceObserver.supportedEntryTypes;
  const frameType = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : null;
  return {
    frames: frameType ? observe<Frame>(frameType, (e, time) => ({ time, duration: e.duration })) : undefined,
    interactions: types.includes('event') ? observe<Interaction>('event', (e, time) => {
      const { interactionId } = e as PerformanceEntry & { interactionId?: number }, kind = POINTER.has(e.name) ? 'pointer' : KEY.has(e.name) ? 'key' : null;
      return interactionId && kind ? { id: interactionId, time, duration: e.duration, kind } : null;
    }, { durationThreshold: 16 }) : undefined,
  };
}

/**
 * How responsive this window was, kept as long as the trend history. Event driven only: no animation-frame loops or probes.
 * `spans` record when the observers were listening, so a quiet stretch can be told apart from one nobody watched.
 */
export class Responsiveness {
  private frames: Frame[] = [];
  private interactions: Interaction[] = [];
  private spans: Span[] = [];
  private started?: number;
  private disconnect: (() => void)[] = [];
  private supported: { frames: boolean; interactions: boolean };
  constructor(private readonly observers: Observers = browserObservers(), private readonly now = () => Date.now()) {
    this.supported = { frames: !!observers.frames, interactions: !!observers.interactions };
  }
  start() {
    if (this.started !== undefined || !(this.supported.frames || this.supported.interactions)) return;
    const started = this.started = this.now();
    try {
      if (this.observers.frames) this.disconnect.push(this.observers.frames(items => {
        const fresh = items.filter(f => f.time >= started && f.duration >= 50);
        if (fresh.length) this.frames = this.frames.concat(fresh).slice(-3000);
      }));
      if (this.observers.interactions) this.disconnect.push(this.observers.interactions(items => {
        // One interaction reports several events (pointerdown, pointerup, click); it is as slow as the slowest of them.
        const merged = this.interactions.slice(-20), older = this.interactions.slice(0, -20);
        for (const item of items) {
          if (item.time < started) continue;
          const same = merged.findIndex(i => i.id === item.id);
          if (same < 0) merged.push(item);
          else if (item.duration > merged[same].duration) merged[same] = { ...merged[same], duration: item.duration };
        }
        this.interactions = older.concat(merged.sort((a, b) => a.time - b.time)).slice(-3000);
      }));
    } catch {
      this.disconnect.forEach(fn => fn()); this.disconnect = []; this.started = undefined;
      this.supported = { frames: false, interactions: false };
    }
  }
  stop() {
    this.disconnect.forEach(fn => fn()); this.disconnect = [];
    if (this.started !== undefined) this.spans = [...this.spans, { start: this.started, end: this.now() }];
    this.started = undefined;
  }
  snapshot(): ResponseLog {
    const now = this.now(), cutoff = now - HISTORY_MS;
    if (this.frames[0]?.time < cutoff) this.frames = this.frames.filter(f => f.time >= cutoff);
    if (this.interactions[0]?.time < cutoff) this.interactions = this.interactions.filter(i => i.time >= cutoff);
    if (this.spans[0]?.end < cutoff) this.spans = this.spans.filter(s => s.end >= cutoff);
    return { frames: this.frames, interactions: this.interactions, supported: this.supported,
      spans: this.started === undefined ? this.spans : [...this.spans, { start: this.started, end: now }] };
  }
}
