import { call } from './api';
import { CADENCE, HISTORY_MS, type Point, type Sample } from './contracts';
import { pointOf } from './insights';
import { Responsiveness, type ResponseLog } from './responsiveness';
import { Tracker, type Tracked } from './tracking';

export interface State { sample?: Sample; points: Point[]; error: string; hidden: boolean; response: ResponseLog; tracked: Tracked }

export const fetchSample = (signal: AbortSignal) => call<Sample>('sample', {}, signal);

/** One sampler shared by the sidebar row and the page; nothing is requested while the window is hidden. */
export class Controller {
  private state: State;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private disposed = false;
  private users = 0;
  private pages = 0;
  private tracker = new Tracker();
  constructor(private readonly read = fetchSample, private readonly doc: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document, private readonly responsiveness = new Responsiveness()) {
    this.state = { points: [], error: '', hidden: doc.hidden, response: responsiveness.snapshot(), tracked: this.tracker.snapshot() };
  }
  snapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(update: Partial<State>) { this.state = { ...this.state, ...update }; this.listeners.forEach(fn => fn()); }
  attach(page = false) {
    this.users++; if (page) this.pages++;
    if (this.users === 1) { this.doc.addEventListener('visibilitychange', this.visibility); this.visibility(); }
    // Opening the page refreshes at once; the Host reuses a reading younger than 1.8 s, so this costs no extra collection.
    else if (page) this.retry();
    return () => {
      this.users--; if (page) this.pages--;
      if (!this.users) { this.doc.removeEventListener('visibilitychange', this.visibility); this.cancel(); this.responsiveness.stop(); }
    };
  }
  private visibility = () => {
    this.cancel(); this.responsiveness.stop();
    this.set({ hidden: this.doc.hidden, response: this.responsiveness.snapshot() });
    if (!this.doc.hidden) { this.responsiveness.start(); void this.tick(); }
  };
  private cancel() { clearTimeout(this.timer); this.request?.abort(); this.request = undefined; }
  retry = () => { if (this.request) return; clearTimeout(this.timer); void this.tick(); };
  private async tick() {
    if (this.disposed || !this.users || this.doc.hidden || this.request) return;
    const request = new AbortController(); this.request = request;
    try {
      const sample = await this.read(request.signal);
      if (request.signal.aborted) return;
      const fresh = this.state.points.at(-1)?.time !== sample.time;
      if (fresh) this.tracker.record(sample);
      this.set({ sample, points: fresh ? this.state.points.filter(p => p.time > sample.time - HISTORY_MS).concat(pointOf(sample)) : this.state.points,
        error: '', response: this.responsiveness.snapshot(), tracked: this.tracker.snapshot() });
    } catch (error) {
      if (!request.signal.aborted) this.set({ error: error instanceof Error ? error.message : '读取失败，请重试。', response: this.responsiveness.snapshot() });
    } finally {
      if (this.request === request) {
        this.request = undefined;
        if (!this.disposed && this.users && !this.doc.hidden) this.timer = setTimeout(() => void this.tick(), this.state.error ? CADENCE.failed : this.pages ? CADENCE.page : CADENCE.idle);
      }
    }
  }
  dispose() { this.disposed = true; this.cancel(); this.responsiveness.stop(); this.doc.removeEventListener('visibilitychange', this.visibility); this.listeners.clear(); }
}
