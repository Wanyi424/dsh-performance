import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { call } from './api';
import { breakdown, rowIndex, visibleKeys } from './breakdown';
import { Conclusion } from './conclusion';
import { CADENCE, type Group, type PluginInfo } from './contracts';
import type { Controller } from './controller';
import type { View } from './details';
import { Drawer } from './drawer';
import { span } from './format';
import { Help, Report } from './icons';
import type { SortKey } from './insights';
import { ownerName } from './labels';
import { report } from './report';
import { Timeline } from './timeline';
import { groupKey } from './tracking';
import { Segmented, copyText, useStored } from './ui';
import { UsageList } from './usage';
import { assess } from './verdict';
import css from './styles.css';

const RANGES = [{ value: '5m', label: '5 分钟', ms: 300_000 }, { value: '15m', label: '15 分钟', ms: 900_000 }, { value: '1h', label: '1 小时', ms: 3_600_000 }] as const;
type Range = typeof RANGES[number]['value'];

/**
 * The details page, one column read top down: the conclusion, the linked trend, and who uses what. Anything opens its details
 * in a drawer over the page, so the page stays where it was and closing the drawer returns to the same line.
 */
export function Page({ controller: c }: { controller: Controller }) {
  const s = useSyncExternalStore(c.subscribe, c.snapshot);
  useEffect(() => c.attach(true), [c]);
  const root = useRef<HTMLDivElement>(null), bar = useRef<HTMLElement>(null), scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useStored<Range>('range', '15m', RANGES.map(r => r.value));
  const [sort, setSort] = useStored<SortKey>('sort', 'cpu', ['cpu', 'memory']);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([groupKey('host')])), [endedOpen, setEndedOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ open: boolean; stack: string[] }>({ open: false, stack: [] });
  const [plugins, setPlugins] = useState<PluginInfo[]>([]), [toast, setToast] = useState<{ id: number; text: string; note: string } | null>(null);
  const sample = s.sample, current = RANGES.find(r => r.value === range)!, end = Date.now(), start = end - current.ms;

  // A plugin installed while the page is open shows up in the split before the list knows its name.
  const unknown = Object.keys(sample?.attribution?.cpu ?? {}).some(id => id.startsWith('plugin:') && !plugins.some(p => `plugin:${p.id}` === id));
  useEffect(() => { void call<PluginInfo[]>('plugins').then(setPlugins, () => {}); }, [unknown]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 2800); return () => clearTimeout(timer); }, [toast]);

  // Pointing at a part anywhere (legend, list) lifts it in the charts. It is a style on the root, so nothing re-renders.
  const focus = useCallback((group: Group | null) => { const el = root.current; if (!el) return; if (group) el.dataset.focus = group; else delete el.dataset.focus; }, []);
  const name = useCallback((id: string) => ownerName(id, plugins), [plugins]);
  const verdict = useMemo(() => assess(s.points, sample, s.response.frames, Date.now()), [s]);
  const data = useMemo(() => breakdown({ sample, points: s.points, tracked: s.tracked, plugins, start, end, sort }), [s, plugins, range, sort]);
  const rows = useMemo(() => rowIndex(data), [data]), order = useMemo(() => visibleKeys(data, expanded, endedOpen), [data, expanded, endedOpen]);
  const view: View = { sample, points: s.points, response: s.response, tracked: s.tracked, plugins, start, end, rangeLabel: current.label, rows };

  // From the page a drawer opens afresh; from inside the drawer it goes one level deeper, and「返回」comes back up.
  const opener = useRef<HTMLElement | null>(null), isOpen = useRef(false);
  const open = useCallback((key: string) => {
    focus(null);
    if (!isOpen.current) opener.current = document.activeElement as HTMLElement | null;
    setDrawer({ open: true, stack: [key] });
  }, [focus]);
  const deeper = useCallback((key: string) => setDrawer(d => ({ open: true, stack: [...d.stack, key] })), []);
  const close = useCallback(() => setDrawer(d => ({ ...d, open: false })), []);
  const back = useCallback(() => setDrawer(d => d.stack.length > 1 ? { ...d, stack: d.stack.slice(0, -1) } : d), []);
  const step = useCallback((by: 1 | -1) => setDrawer(d => { const next = order[order.indexOf(d.stack[0]) + by]; return next && order.includes(d.stack[0]) ? { open: true, stack: [next] } : d; }), [order]);
  const toggle = useCallback((key: string) => setExpanded(set => { const next = new Set(set); if (!next.delete(key)) next.add(key); return next; }), []);
  // While the drawer is open the page beneath is out of reach; closing it hands focus back to what opened it.
  useEffect(() => {
    isOpen.current = drawer.open;
    for (const el of [bar.current, scroller.current]) if (el) { if (drawer.open) el.setAttribute('inert', ''); else el.removeAttribute('inert'); }
    if (!drawer.open && opener.current) { opener.current.focus({ preventScroll: true }); opener.current = null; }
  }, [drawer.open]);

  const copy = () => void copyText(report({ now: Date.now(), rangeMs: current.ms, rangeLabel: current.label, sample, points: s.points, response: s.response, verdict, rows: data, plugins })).then(
    () => setToast({ id: Date.now(), text: '已复制诊断报告', note: '只列程序名，不含命令行和文件路径，可以直接粘贴到反馈里' }),
    () => setToast({ id: Date.now(), text: '复制失败', note: '请再试一次' }));
  const stale = !!s.error;

  return <div ref={root} className="dpm-root"><style>{css}</style>
    <header ref={bar} className="dpm-bar">
      <h1>DSH 性能监控</h1>
      <span className="dpm-live" data-state={stale ? 'paused' : sample ? 'live' : 'connecting'}><i key={sample?.time} />
        {stale ? '已暂停更新' : sample ? `实时 · 每 ${CADENCE.page / 1000} 秒` : '正在连接…'}</span>
      <span className="dpm-spacer" />
      <Segmented label="时间范围" value={range} options={RANGES.map(({ value, label }) => ({ value, label }))} onChange={setRange} />
      <button type="button" className="dpm-button" aria-label="复制诊断报告" title="复制诊断报告" disabled={!sample} onClick={copy}><Report size={14} /><span className="dpm-report-label">复制诊断报告</span></button>
      <button type="button" className="dpm-icon-button" aria-label="这些数字怎么来的" title="这些数字怎么来的" onClick={() => open('about')}><Help /></button>
    </header>
    <div ref={scroller} className="dpm-scroll" onScroll={event => { const el = root.current; if (el) { if (event.currentTarget.scrollTop > 2) el.dataset.scrolled = ''; else delete el.dataset.scrolled; } }}>
      <main className="dpm-content">
        <Conclusion verdict={verdict} error={s.error} onRetry={c.retry} onOpen={open} onRules={() => open('about')} />
        <Timeline points={s.points} response={s.response} programs={s.tracked.programs} sample={sample} start={start} end={end} rangeLabel={current.label} stale={stale}
          ownerName={name} onOpen={open} onFocus={focus} />
        <UsageList data={data} ready={!!sample} sort={sort} onSort={setSort} start={start} end={end} rangeLabel={current.label} expanded={expanded} onToggle={toggle}
          endedOpen={endedOpen} onEnded={() => setEndedOpen(v => !v)} active={drawer.open ? drawer.stack[0] : null} stale={stale} onOpen={open} onFocus={focus} />
        <footer className="dpm-foot">
          {sample && <span>DSH 已运行 {span(sample.time - sample.started)}</span>}
          {!!sample?.unavailable && <span data-tone="warn">{sample.unavailable} 个进程没有读取权限，未计入</span>}
          {sample && sample.memory === null && <span data-tone="warn">当前 Windows 版本不提供专用工作集，内存无法显示</span>}
          <span>数据只保存在内存里，保留最近 1 小时</span>
        </footer>
      </main>
    </div>
    <Drawer open={drawer.open} stack={drawer.stack} view={view} order={order} onClose={close} onBack={back} onNav={step} onOpen={deeper} />
    {toast && <div key={toast.id} className="dpm-toast" role="status">{toast.text}<small>{toast.note}</small></div>}
  </div>;
}
