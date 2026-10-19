import inspector from 'node:inspector';
import { Session } from 'node:inspector/promises';
import { dirname } from 'node:path';
import { Attributor, ownersOf, top, type CpuProfile, type HeapNode, type Tallies } from './attribution';
import { HISTORY_MS, PROFILER, type Attribution, type OwnerDetail, type ProfilerState } from './contracts';
import type { PluginDir } from './plugins';

/** A window this long cannot be one reading's interval: readings stopped and the timer was held up. */
const MAX_WINDOW_MS = 60_000;
const MINUTE = 60_000;
/** While connected, V8 keeps the arguments of recent console calls for the inspector; they are let go this often. */
const RELEASE_MS = 30_000;

/**
 * The Host profiling itself from the moment it starts, so every reading can split its main thread and memory by plugin,
 * whether or not the page is open:
 * - CPU: V8's sampling profiler in overlapping windows, so it never restarts in between (a restart walks the whole heap and
 *   pauses the Host, about 0.3 s at a 150 MB heap). Each reading closes the running window and opens the next; while no
 *   readings come (the window hidden), a timer does, so the functions behind the time are still recorded and no profile grows.
 * - Memory: V8's sampling heap profiler. Reading it collects garbage first, so it is read seldom, and only while readings come.
 * The user can pause it until they resume it or DSH restarts, for example while debugging the Host with DevTools.
 */
export class HostProfiler {
  private session?: Session;
  private starting?: Promise<void>;
  /** Whether it should run: the Host starts it, the user may pause it. */
  private wanted = false;
  private disposed = false;
  private state: ProfilerState = 'paused';
  private error: string | null = null;
  private readonly attributor: Attributor;
  /** Console-profile title of the open window, and when it opened. */
  private running: string | null = null;
  private openedAt = 0;
  private ending: string | null = null;
  private received?: CpuProfile;
  private count = 0;
  private since: number | null = null;
  private startPauseMs: number | null = null;
  private memory: Attribution['memory'] = null;
  private held: Tallies = new Map();
  private nextRead = 0;
  private reading = false;
  /** Per-minute time by function (plugins) or package (DSH, other) for each owner, an hour deep, for the details view. */
  private minutes: { minute: number; owners: Map<string, Map<string, number>> }[] = [];
  private ticker?: ReturnType<typeof setInterval>;
  private release?: ReturnType<typeof setInterval>;
  constructor(private readonly plugins: () => readonly PluginDir[], root = dirname(process.execPath), private readonly now = () => Date.now()) {
    this.attributor = new Attributor(root);
  }

  /** Called when the Host starts, and when the user resumes. */
  start(): Promise<void> {
    this.wanted = true;
    if (this.disposed || this.session) return Promise.resolve();
    return this.starting ??= this.open().finally(() => { this.starting = undefined; });
  }
  /** Stops both profilers and lets the inspector session go; what was recorded so far stays viewable. */
  pause() {
    this.wanted = false;
    if (!this.starting) this.stop();
  }
  status(): Omit<Attribution, 'cpu'> { return { memory: this.memory, state: this.state, since: this.since, startPauseMs: this.startPauseMs, error: this.error }; }

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
      this.state = 'unavailable';
      this.error = `当前环境无法按插件统计后台：${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    this.session = session; this.state = 'running'; this.error = null;
    this.since = this.now(); this.nextRead = this.since + PROFILER.firstMemoryMs;
    const started = performance.now();
    inspector.console.profile(this.running = this.title());
    this.startPauseMs = performance.now() - started; this.openedAt = this.now();
    this.ticker = setInterval(() => { if (this.now() - this.openedAt >= PROFILER.windowMs) this.rotate(); }, PROFILER.windowMs / 2); this.ticker.unref();
    this.release = setInterval(() => void session.post('Runtime.discardConsoleEntries').catch(() => {}), RELEASE_MS); this.release.unref();
    // Paused or disposed while the inspector handshake was in flight.
    if (!this.wanted || this.disposed) this.stop();
  }

  /**
   * Called on each fresh reading: closes the running window and opens the next. Returns what the reading carries: each owner's
   * share of the machine over the window just closed, and the latest memory reading.
   */
  take(cores: number): Attribution {
    const window = this.rotate();
    if (this.state === 'running' && !this.reading && this.now() >= this.nextRead) { this.reading = true; setImmediate(() => void this.readMemory()); }
    let cpu: Record<string, number> | null = null;
    if (window) {
      cpu = {};
      for (const id of ownersOf(this.plugins())) cpu[id] = (window.owners.get(id)?.value ?? 0) / window.durationMs / cores * 100;
    }
    return { cpu, ...this.status() };
  }

  /** Where an owner's time went over [from, to], from the per-minute record, and where its memory sits at the latest reading. */
  detail(id: string, from: number, to: number): OwnerDetail {
    const merged = new Map<string, number>();
    for (const m of this.minutes) if (m.minute + MINUTE > from && m.minute <= to) for (const [key, ms] of m.owners.get(id) ?? []) merged.set(key, (merged.get(key) ?? 0) + ms);
    return { cpu: top(merged), memory: top(this.held.get(id)?.hot ?? new Map()), memoryAt: this.memory?.at ?? null };
  }

  private title() { return `dsh-performance#${++this.count}`; }
  /** The next window opens before the running one closes, so the profiler keeps running between them. */
  private rotate(): { owners: Tallies; durationMs: number } | null {
    if (!this.running) return null;
    const next = this.title();
    inspector.console.profile(next);
    const profile = this.close(this.running); this.running = next; this.openedAt = this.now();
    const durationMs = profile ? (profile.endTime - profile.startTime) / 1000 : 0;
    if (!profile || durationMs <= 0) return null;
    const { owners } = this.attributor.cpu(profile, this.plugins());
    this.bank(owners);
    return durationMs > MAX_WINDOW_MS ? null : { owners, durationMs };
  }
  private close(title: string) {
    this.ending = title; this.received = undefined;
    inspector.console.profileEnd(title);
    // Set by the event handler during profileEnd, which the compiler cannot see.
    const profile = this.received as CpuProfile | undefined; this.ending = null; this.received = undefined;
    return profile;
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
  private stop() {
    clearInterval(this.ticker); clearInterval(this.release);
    this.ticker = undefined; this.release = undefined;
    const session = this.session; this.session = undefined;
    if (this.running) { this.close(this.running); this.running = null; }
    this.received = undefined;
    if (this.state === 'running') this.state = 'paused';
    if (!session) return;
    void session.post('HeapProfiler.stopSampling').catch(() => {});
    void session.post('Runtime.discardConsoleEntries').catch(() => {});
    session.disconnect();
  }
  dispose() { this.disposed = true; this.pause(); }
}
