import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { calculate } from './metrics';
import type { RawSample, Sample } from './contracts';

/** One helper per plugin, sampling strictly on demand. Concurrent callers share one result. */
export class Sampler {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private pending?: { resolve(value: RawSample): void; reject(error: Error): void };
  private flight?: Promise<Sample>;
  private previous?: RawSample;
  private cached?: Sample;
  private cachedAt = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly executable = fileURLToPath(new URL('./collector.exe', import.meta.url)), private readonly args = [String(process.pid)],
    private readonly plugins: () => readonly { id: string; dir: string }[] = () => []) {}
  private stop() {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    this.lines?.close(); this.lines = undefined;
    this.previous = undefined; this.cached = undefined;
    this.pending?.reject(new Error('采集器已停止。')); this.pending = undefined;
    child?.kill();
  }
  private start() {
    if (process.platform !== 'win32') throw new Error('运行监控仅支持 Windows 本地桌面版。');
    const child = spawn(this.executable, this.args, { windowsHide: true, shell: false, stdio: 'pipe' });
    this.child = child;
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.pending?.reject(error); this.pending = undefined; this.stop();
    };
    child.on('error', () => fail(new Error('无法启动监控采集器，请检查插件安装是否完整。')));
    child.on('exit', () => fail(new Error('监控采集器意外退出，请重试。')));
    child.stdin.on('error', () => fail(new Error('无法连接监控采集器。')));
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      if (this.child !== child || !this.pending) return;
      const pending = this.pending; this.pending = undefined;
      try {
        const result = JSON.parse(line) as RawSample & { error?: string };
        if (result.error) throw new Error(result.error);
        pending.resolve(result);
      } catch (error) { pending.reject(error instanceof Error ? error : new Error('无法读取采集结果。')); }
    });
  }
  async sample(): Promise<Sample> {
    if (this.disposed) throw new Error('监控已关闭。');
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), 15_000); this.idle.unref();
    if (this.flight) return this.flight;
    if (this.cached && performance.now() - this.cachedAt < 1_800) return this.cached;
    this.flight = this.collect().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async collect(): Promise<Sample> {
    if (!this.child) this.start();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await new Promise<RawSample>((resolve, reject) => {
        this.pending = { resolve, reject };
        timeout = setTimeout(() => { reject(new Error('采集超时，请稍后重试。')); this.stop(); }, 5_000);
        this.child!.stdin.write('sample\n');
      });
      this.cached = calculate(raw, this.previous, this.plugins()); this.previous = raw; this.cachedAt = performance.now();
      return this.cached;
    } catch (error) { this.stop(); throw error; }
    finally { clearTimeout(timeout); }
  }
  dispose() { this.disposed = true; this.stop(); }
}
