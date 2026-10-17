import { Session } from 'node:inspector/promises';
import { dirname } from 'node:path';
import { attribute, type CpuProfile, type HeapNode } from './attribution';
import type { AnalysisState } from './contracts';
import type { PluginDir } from './plugins';

/**
 * Samples this Host process from the inside for a set time: the V8 CPU profiler (every millisecond) and the sampling heap
 * profiler (every 32 KB allocated), then charges both to plugins. Nothing runs between analyses. The closing garbage
 * collection, which keeps only memory that is really still held, can pause the Host briefly once.
 */
export class Analyzer {
  private state: AnalysisState = { state: 'idle' };
  private session?: Session;
  private timer?: ReturnType<typeof setTimeout>;
  private finished?: Promise<void>;
  private settle?: () => void;
  constructor(private readonly plugins: () => Promise<readonly PluginDir[]>, private readonly root = dirname(process.execPath)) {}
  status(): AnalysisState { return this.state; }
  private last() { const s = this.state; return s.state === 'done' ? { startedAt: s.startedAt, seconds: s.seconds, result: s.result } : s.state === 'idle' || s.state === 'running' ? s.last : undefined; }
  async start(seconds: number): Promise<AnalysisState> {
    if (this.state.state === 'running') throw new Error('已有一次分析正在进行。');
    const session = new Session(), last = this.last();
    try {
      session.connect();
      await session.post('Profiler.enable');
      await session.post('Profiler.setSamplingInterval', { interval: 1000 });
      await session.post('HeapProfiler.enable');
      await session.post('HeapProfiler.startSampling', { samplingInterval: 32 * 1024 });
      await session.post('Profiler.start');
    } catch (error) {
      session.disconnect();
      throw new Error(`当前环境无法分析后台：${error instanceof Error ? error.message : String(error)}`);
    }
    const startedAt = Date.now();
    this.session = session; this.state = { state: 'running', startedAt, seconds, last };
    this.finished = new Promise(resolve => {
      this.settle = resolve;
      this.timer = setTimeout(() => void this.finish(session, startedAt, seconds).finally(resolve), seconds * 1000);
    });
    return this.state;
  }
  /** Resolves when the running analysis has a result (or failed); for tests and shutdown. */
  wait() { return this.finished ?? Promise.resolve(); }
  private async finish(session: Session, startedAt: number, seconds: number) {
    try {
      const { profile } = await session.post('Profiler.stop');
      let heap: HeapNode | null = null;
      try {
        await session.post('HeapProfiler.collectGarbage');
        heap = (await session.post('HeapProfiler.getSamplingProfile')).profile.head as HeapNode;
      } catch { /* the CPU result stands on its own */ }
      if (this.session !== session) return;
      this.state = { state: 'done', startedAt, seconds, result: attribute(profile as CpuProfile, heap, await this.plugins(), this.root) };
    } catch (error) {
      if (this.session === session) this.state = { state: 'failed', startedAt, seconds, error: error instanceof Error ? error.message : '分析失败。' };
    } finally {
      if (this.session === session) this.close();
    }
  }
  /** Stops a running analysis and keeps showing the previous result, if any. */
  cancel(): AnalysisState {
    if (this.state.state === 'running') { const last = this.state.last; this.close(); this.state = last ? { state: 'done', ...last } : { state: 'idle' }; }
    return this.state;
  }
  /** Disconnecting the session switches both profilers off and drops what they held. */
  private close() {
    clearTimeout(this.timer);
    this.session?.disconnect(); this.session = undefined;
    this.settle?.(); this.settle = undefined;
  }
  dispose() { this.cancel(); }
}
