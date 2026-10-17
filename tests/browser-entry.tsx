// Isolated DSH slot carrier. Tests load the actual built client without account access.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Responsiveness } from '../src/responsiveness';
import { pointOf, programs, summarize } from '../src/insights';
import type { Point, ProcessMetric, Sample } from '../src/contracts';

/** An hour of 2-second points over a tree with tool programs: the most the page ever computes on one reading. */
(window as unknown as { runStatisticsProbe(): unknown }).runStatisticsProbe = () => {
  const processes: ProcessMetric[] = Array.from({ length: 16 }, (_, i) => ({ pid: i + 1, parent: i > 8 ? i : 0, created: 1, name: i > 8 ? 'node.exe' : 'DeepSeek Harness.exe',
    kind: i > 8 ? 'tool' : 'renderer', group: i > 8 ? 'tools' : 'ui', threads: 8, detail: null, cpu: 1, memory: 10 * 1024 ** 2 }));
  const sample = { time: 0, intervalMs: 2000, cpu: 16, memory: 160 * 1024 ** 2, system: { cpu: 30, memoryUsed: 8 * 1024 ** 3, memoryTotal: 16 * 1024 ** 3 }, processes } as Sample;
  const history: Point[] = Array.from({ length: 1800 }, (_, i) => pointOf({ ...sample, time: i * 2000 }));
  const times: number[] = [];
  for (let i = 0; i < 110; i++) { const start = performance.now(); summarize(history, 0, 3_600_000); programs(processes); pointOf(sample); if (i >= 10) times.push(performance.now() - start); }
  return { points: history.length, processes: processes.length, iterations: times.length, averageMs: times.reduce((a, b) => a + b, 0) / times.length, maxMs: Math.max(...times) };
};
/** Real Chromium long frames reach the observer: six main-thread stalls of about 65 ms. */
(window as unknown as { runTaskProbe(): Promise<unknown> }).runTaskProbe = async () => {
  const monitor = new Responsiveness(); monitor.start();
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 40)); const end = performance.now() + 65; while (performance.now() < end) { /* isolated test only */ } }
  await new Promise(r => setTimeout(r, 120)); monitor.stop(); return monitor.snapshot().frames.length;
};

const modules: Record<string, unknown> = { react: React };
const main = createRoot(document.getElementById('main')!), footer = createRoot(document.getElementById('footer-action')!);
let Page: React.ComponentType, Entry: React.ComponentType<{ wide: boolean }>, wide = true, active: string | null = null;
const listeners = new Set<() => void>();
const ctx = {
  locale: { register() { return () => {}; } },
  effect(effect: () => (() => unknown)) { effect(); },
  layout: {
    selectPanel(id: string | null) { active = id; listeners.forEach(fn => fn()); main.render(id ? <Page /> : <div style={{ padding: 40 }}>工作台</div>); },
    panelInfo: { getSnapshot: () => ({ activePanelId: active }), subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; } },
  },
  slots: {
    inject(_slot: string, register: () => unknown) { register(); },
    register(options: { name: string }, Component: React.ComponentType<any>) {
      if (options.name === 'main') Page = Component;
      if (options.name === 'sidebar.footer.action') { Entry = Component; footer.render(<Entry wide={wide} />); }
      return () => {};
    },
  },
};
document.getElementById('close-panel')!.onclick = () => ctx.layout.selectPanel(null);
// The host marks dark mode on <body>, as DSH's theme presenter does.
new MutationObserver(() => document.body.toggleAttribute('data-ds-dark-theme', document.documentElement.dataset.theme === 'dark'))
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
document.getElementById('collapse')!.onclick = () => { wide = !wide; document.body.dataset.collapsed = String(!wide); footer.render(<Entry wide={wide} />); };
type Factory = (require: ((id: string) => unknown) & { async(path: string): Promise<unknown> }) => unknown;
const factories = new Map<string, Factory>(), cache = new Map<string, unknown>();
const localRequire = Object.assign((id: string) => { if (!(id in modules)) throw new Error(`Unresolved module: ${id}`); return modules[id]; }, {
  async(path: string): Promise<unknown> {
    const file = path.slice(2), id = `dsh-performance/${file}`;
    if (cache.has(id)) return Promise.resolve(cache.get(id));
    return new Promise<void>((resolve, reject) => { const script = document.createElement('script'); script.src = '/' + file; script.onload = () => resolve(); script.onerror = () => reject(new Error('Chunk failed')); document.head.append(script); }).then(() => { const result = factories.get(id)!(localRequire); cache.set(id, result); return result; });
  },
});
(window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
  load(entry: { id: string; factory: Factory }) { factories.set(entry.id, entry.factory); if (entry.id === 'dsh-performance') (entry.factory(localRequire) as { apply(ctx: unknown): void }).apply(ctx); },
};
