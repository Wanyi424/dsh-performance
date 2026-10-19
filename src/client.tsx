import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Controller } from './controller';
import { PANEL } from './contracts';
import { bytes, cpu } from './format';
import { Gauge } from './icons';
import type { ClientContext } from './types';
import { assess } from './verdict';
import css from './widget.css';
declare const require: { async<T>(path: string): Promise<T> };

/**
 * The plugin's entry in the sidebar footer: a row like the host's panel rows, with DSH's live totals beside the label. When the
 * page's conclusion asks for attention, a dot appears and the row's title says why.
 */
function Entry({ controller: c, ctx, wide = true }: { controller: Controller; ctx: ClientContext; wide?: boolean }) {
  const s = useSyncExternalStore(c.subscribe, c.snapshot);
  const active = useSyncExternalStore(ctx.layout.panelInfo.subscribe, () => ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL);
  useEffect(() => c.attach(), [c]);
  const verdict = useMemo(() => assess(s.points, s.sample, s.response.frames, Date.now()), [s]), alert = verdict?.level === 'warn' ? verdict : null;
  const status = s.error ? '读取失败' : s.sample ? `CPU ${cpu(s.sample.cpu)}，内存 ${bytes(s.sample.memory)}` : '正在读取';
  return <button type="button" className={wide ? 'dpm-entry' : 'dpm-entry dpm-compact'} data-state={s.error ? 'error' : alert ? 'warn' : undefined}
    aria-current={active ? 'page' : undefined} aria-label={`运行监控，${status}${alert ? `，${alert.title}` : ''}`}
    title={alert ? `${alert.title}：${alert.detail}` : wide ? undefined : `运行监控 · ${status}`} onClick={() => ctx.layout.selectPanel(PANEL)}>
    <span className="dpm-entry-icon"><Gauge size={wide ? 16 : 18} />{(s.error || alert) && <i className="dpm-entry-dot" />}</span>
    {wide && <>
      <span className="dpm-entry-label">运行监控</span>
      <span className="dpm-entry-value" aria-hidden="true">{s.error ? '读取失败' : s.sample ? `${cpu(s.sample.cpu)} · ${bytes(s.sample.memory)}` : '…'}</span>
    </>}
  </button>;
}

const hint: React.CSSProperties = { height: '100%', display: 'grid', placeContent: 'center', gap: 12, justifyItems: 'center', color: 'var(--dsw-alias-label-tertiary)', font: "13px 'Segoe UI', 'Microsoft YaHei UI', sans-serif" };
function LazyPage({ controller }: { controller: Controller }) {
  const [Page, setPage] = useState<React.ComponentType<{ controller: Controller }> | null>(null);
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0), [slow, setSlow] = useState(false);
  useEffect(() => {
    let live = true; const timer = setTimeout(() => setSlow(true), 200);
    require.async<typeof import('./page')>('./client.page.js').then(m => { if (live) setPage(() => m.Page); }, () => { if (live) setFailed(true); });
    return () => { live = false; clearTimeout(timer); };
  }, [attempt]);
  if (Page) return <Page controller={controller} />;
  // A local chunk usually arrives within a frame or two; only show the hint when it does not.
  return <div style={hint} role="status">{failed ? <>运行监控页面加载失败<button onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>重试</button></> : slow ? '正在打开运行监控…' : null}</div>;
}

export const inject = ['slots', 'locale', 'layout'];
export function apply(ctx: ClientContext) {
  const controller = new Controller();
  ctx.effect(() => () => controller.dispose(), 'performance: sampler');
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    return () => style.remove();
  }, 'performance: sidebar styles');
  ctx.effect(() => ctx.locale.register('performance', { zh: { title: '运行监控' }, en: { title: 'Performance' } }), 'performance: locale');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: 'performance' }, () => <LazyPage controller={controller} />));
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: PANEL, order: 50 },
    (props: { wide: boolean }) => <Entry {...props} controller={controller} ctx={ctx} />));
}
