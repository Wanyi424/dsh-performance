import inspector from 'node:inspector';
import { Session } from 'node:inspector/promises';
import { dirname } from 'node:path';
import { Attributor, ownersOf, top, type CpuProfile, type HeapNode, type Tallies } from './attribution';
import { HISTORY_MS, PROFILER, type Attribution, type OwnerDetail } from './contracts';
import type { PluginDir } from './plugins';

/** A window longer than this spans a break in the readings (a hidden window), so it is not charged to one interval. */
const MAX_WINDOW_MS = 10_000;
const MINUTE = 60_000;
/** While connected, V8 keeps the arguments of recent console calls for the inspector; they are let go this often. */
const RELEASE_MS = 30_000;

/**
 * The Host profiling itself, so its main thread and memory can be split by plugin. It is opened only while the details page is
 * visible. CPU windows overlap so the profiler does not restart between readings; memory is read seldom because it collects
 * garbage first. The ordinary sidebar sampler never opens this inspector session.
 */
export class HostProfiler {
  private session?: Session;
  private starting?: Promise<void>;
  private enabled = false;
  private error: string | null = null;
  private readonly attributor: Attributor;
  /** Console-profile title of the open window, if the profiler runs. */
  private running: string | null = null;
  private ending: string | null = null;
  private received?: CpuProfile;
  private count = 0;
  private startPauseMs: number | null = null;
  private memory: Attribution['memory'] = null;
  private held: Tallies = new Map();
  private nextRead: number;
  private reading = false;
  /** Per-minute time by function (plugins) or package (DSH, other) for each owner, an hour deep, for the details view. */
  private minutes: { minute: number; owners: Map<string, Map<string, number>> }[] = [];
  private linger?: ReturnType<typeof setTimeout>;
  private release?: ReturnType<typeof setInterval>;
  constructor(private readonly plugins: () => readonly PluginDir[], root = dirname(process.execPath), private readonly now = () => Date.now()) {
    this.attributor = new Attributor(root);
    this.nextRead = now() + PROFILER.firstMemoryMs;
  }

  /** Enable the expensive Host attribution only while the details page needs it. */
  async enable() {
    this.enabled = true;
    if (this.session) return;
    if (this.starting) return this.starting;
    this.starting = this.open().finally(() => { this.starting = undefined; });
    await this.starting;
  }

  /** Kept as a small compatibility alias for tests and embedders. */
  async start() { return this.enable(); }

  /** Stop both profilers and release their inspector session immediately. */
  disable() {
    this.enabled = false;
    if (this.starting) {
      void this.starting.then(() => { if (!this.enabled) this.stopSession(); });
      return;
    }
    this.stopSession();
  }

  private async open() {
    const session = new Session();
    try {
      session.connect();
      // In-process sessions deliver events synchronously, so a window's profile arrives inside console.profileEnd.
      session.on('Profiler.consoleProfileFinished', ({ params }) => { if (params.title === this.ending) this.received = params.profile as CpuProfile; });
      await session.post('Profiler.enable');
      await session.post('Profiler.setSamplingInterval', { interval: PROFILER.sampleMs * 1000 });
      await session.post('HeapProfiler.enable');
      await session.post('HeapProfiler.startSampling', { samplingInterval: PROFILER.heapBytes });
    } catch (error) {
      session.disconnect();
      this.enabled = false;
      this.error = `当前环境无法按插件统计后台：${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    this.session = session;
    this.release = setInterval(() => void session.post('Runtime.discardConsoleEntries').catch(() => {}), RELEASE_MS); this.release.unref();
    // A page can disappear while the inspector handshake is in flight.
    if (!this.enabled) this.stopSession();
  }

  /**
   * Called on each fresh reading: closes the running window and opens the next. Returns what the reading carries: each owner's
   * share of the machine over the window just closed, and the latest memory reading.
   */
  take(cores: number): Attribution {
    const rest = () => ({ memory: this.memory, startPauseMs: this.startPauseMs, error: this.error });
    if (!this.enabled || !this.session) return { cpu: null, ...rest() };
    this.keep();
    const next = `dsh-performance#${++this.count}`;
    if (this.running === null) {
      const started = performance.now(); inspector.console.profile(next); this.startPauseMs = performance.now() - started;
      this.running = next;
      return { cpu: null, ...rest() };
    }
    // The next window opens before this one closes, so the profiler keeps running between them.
    inspector.console.profile(next);
    const profile = this.close(this.running); this.running = next;
    const durationMs = profile ? (profile.endTime - profile.startTime) / 1000 : 0;
    if (!profile || durationMs <= 0 || durationMs > MAX_WINDOW_MS) return { cpu: null, ...rest() };
    const plugins = this.plugins(), { owners } = this.attributor.cpu(profile, plugins), cpu: Record<string, number> = {};
    for (const id of ownersOf(plugins)) cpu[id] = (owners.get(id)?.value ?? 0) / durationMs / cores * 100;
    this.bank(owners);
    return { cpu, ...rest() };
  }

  /** Where an owner's time went over [from, to], from the per-minute record, and where its memory sits at the latest reading. */
  detail(id: string, from: number, to: number): OwnerDetail {
    const merged = new Map<string, number>();
    for (const m of this.minutes) if (m.minute + MINUTE > from && m.minute <= to) for (const [key, ms] of m.owners.get(id) ?? []) merged.set(key, (merged.get(key) ?? 0) + ms);
    return { cpu: top(merged), memory: top(this.held.get(id)?.hot ?? new Map()), memoryAt: this.memory?.at ?? null };
  }

  private close(title: string) {
    this.ending = title; this.received = undefined;
    inspector.console.profileEnd(title);
    // Set by the event handler during profileEnd, which the compiler cannot see.
    const profile = this.received as CpuProfile | undefined; this.ending = null; this.received = undefined;
    return profile;
  }
  /** Readings are coming in: keep the profiler up a while longer, and read memory when it is due. */
  private keep() {
    clearTimeout(this.linger);
    this.linger = setTimeout(() => { if (this.running) { this.close(this.running); this.running = null; } }, PROFILER.lingerMs); this.linger.unref();
    if (!this.reading && this.now() >= this.nextRead) { this.reading = true; setImmediate(() => void this.readMemory()); }
  }
  /** After the reading that triggered it has been answered: the garbage collection this costs does not delay that answer. */
  private async readMemory() {
    const session = this.session;
    try {
      if (!session) return;
      // Console arguments V8 kept for the inspector are not held by the code that logged them; let them go first.
      await session.post('Runtime.discardConsoleEntries');
      const started = performance.now(), { profile } = await session.post('HeapProfiler.getSamplingProfile'), pauseMs = performance.now() - started;
      const plugins = this.plugins(), { owners } = this.attributor.heap(profile.head as HeapNode, plugins), values: Record<string, number> = {};
      for (const id of ownersOf(plugins)) values[id] = owners.get(id)?.value ?? 0;
      this.memory = { at: this.now(), owners: values, pauseMs }; this.held = owners;
    } catch { /* tried again at the next due reading */ }
    finally { this.reading = false; this.nextRead = this.now() + PROFILER.memoryEveryMs; }
  }
  private bank(owners: Tallies) {
    const at = this.now(), minute = at - at % MINUTE;
    let m = this.minutes.at(-1);
    if (m?.minute !== minute) {
      // A finished minute keeps its 20 busiest entries per owner; the details view shows five.
      if (m) for (const [id, hot] of m.owners) m.owners.set(id, new Map([...hot].sort((a, b) => b[1] - a[1]).slice(0, 20)));
      this.minutes.push(m = { minute, owners: new Map() });
      while (this.minutes[0].minute <= at - HISTORY_MS) this.minutes.shift();
    }
    for (const [id, t] of owners) {
      if (!t.hot.size) continue;
      let hot = m.owners.get(id);
      if (!hot) m.owners.set(id, hot = new Map());
      for (const [key, ms] of t.hot) hot.set(key, (hot.get(key) ?? 0) + ms);
    }
  }
  dispose() {
    this.enabled = false;
    if (this.starting) void this.starting.then(() => this.stopSession());
    else this.stopSession();
  }

  private stopSession() {
    clearTimeout(this.linger); clearInterval(this.release);
    this.linger = undefined; this.release = undefined;
    const session = this.session; this.session = undefined;
    if (this.running) { this.close(this.running); this.running = null; }
    this.received = undefined;
    this.memory = null; this.held = new Map(); this.minutes = [];
    this.startPauseMs = null; this.nextRead = this.now() + PROFILER.firstMemoryMs;
    this.error = null;
    if (!session) return;
    void session.post('HeapProfiler.stopSampling').catch(() => {});
    void session.post('Runtime.discardConsoleEntries').catch(() => {});
    session.disconnect();
  }
}
