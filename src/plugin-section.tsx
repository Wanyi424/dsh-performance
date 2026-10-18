import React, { memo, useEffect, useState } from 'react';
import { call } from './api';
import { ANALYSIS_SECONDS, type Analysis, type AnalysisState, type Hot, type Owner, type PluginInfo, type Sample } from './contracts';
import { bytes, clock, cpu } from './format';
import { Chevron } from './icons';
import { programs } from './insights';
import { Segmented, useStored } from './ui';

const SELF = 'dsh-performance';
const seconds = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} 秒` : `${Math.round(ms)} ms`;
const share = (part: number, whole: number) => !whole ? '—' : part / whole < .005 && part > 0 ? '<1%' : `${Math.round(part / whole * 100)}%`;

/** The page's view of the Host's analysis: start, cancel, and a poll once a second while one runs. */
function useAnalysis() {
  const [state, setState] = useState<AnalysisState>({ state: 'idle' }), [error, setError] = useState('');
  const run = (action: string, extra?: Record<string, unknown>) => call<AnalysisState>(action, extra).then(next => { setState(next); setError(''); }, e => setError(e instanceof Error ? e.message : '请求失败'));
  useEffect(() => { void run('analysis'); }, []);
  useEffect(() => {
    if (state.state !== 'running') return;
    const timer = setTimeout(() => void run('analysis'), 1000);
    return () => clearTimeout(timer);
  }, [state]);
  return { state, error, start: (s: number) => run('analyze', { seconds: s }), cancel: () => run('cancel') };
}

function HotList({ title, items, format }: { title: string; items: Hot[]; format(value: number): string }) {
  return <div className="dpm-hot"><h4>{title}</h4>{items.length ? <ol>{items.map(h => <li key={h.name + h.where}>
    <span className="dpm-hot-name"><code>{h.name}</code><small>{h.where}</small></span><b>{format(h.value)}</b>
  </li>)}</ol> : <p>这段时间没有记录到</p>}</div>;
}

function Row({ owner, label, note, busy, helpers, open, onToggle }: {
  owner?: Owner; label: string; note?: string; busy: number; helpers: { cpu: number | null; memory: number | null } | null; open: boolean; onToggle(): void;
}) {
  const expandable = !!owner && (owner.kind === 'plugin' ? owner.functions.length + owner.allocations.length > 0 : !!owner.modules?.length);
  return <>
    <tr data-kind={owner?.kind ?? 'plugin'} data-open={open || undefined}>
      <th scope="row">
        <span className="dpm-name">
          {expandable ? <button type="button" className="dpm-expand" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}${label}的详情`} onClick={onToggle}><Chevron size={14} /></button> : <span className="dpm-expand-space" />}
          <span className="dpm-name-text"><strong>{label}</strong>{note && <small>{note}</small>}</span>
        </span>
      </th>
      <td>{owner ? <span className="dpm-meter-cell" title={seconds(owner.cpuMs)}><span className="dpm-meter" aria-hidden="true"><i style={{ width: `${busy ? Math.min(100, owner.cpuMs / busy * 100) : 0}%` }} /></span>{share(owner.cpuMs, busy)}</span> : '—'}</td>
      <td>{owner?.memory != null && owner.kind !== 'gc' ? bytes(owner.memory) : '—'}</td>
      <td>{helpers ? <span className="dpm-helpers">{cpu(helpers.cpu)} · {bytes(helpers.memory)}</span> : '—'}</td>
    </tr>
    {open && owner && <tr className="dpm-plugin-detail"><td colSpan={4}>
      {owner.kind === 'plugin' ? <div className="dpm-hot-grid">
        <HotList title="CPU 耗时最多的函数" items={owner.functions} format={seconds} />
        <HotList title="新增内存最多的位置" items={owner.allocations} format={bytes} />
      </div> : <div className="dpm-hot-grid"><HotList title={owner.kind === 'core' ? 'DSH 中最忙的模块' : '主要来源'}
        items={(owner.modules ?? []).map(m => ({ name: m.name, where: m.memory ? `新增内存 ${bytes(m.memory)}` : '', value: m.cpuMs }))} format={seconds} /></div>}
    </td></tr>}
  </>;
}

/**
 * Plugins share DSH's Host process, so Windows cannot meter them apart. Their own helper processes are metered live; their
 * share of the Host comes from an analysis the user starts, which samples the Host's call stacks for a set time.
 */
export const PluginSection = memo(function PluginSection({ plugins, sample }: { plugins: PluginInfo[]; sample?: Sample }) {
  const { state, error, start, cancel } = useAnalysis();
  const [length, setLength] = useStored<'10' | '30' | '60'>('analysis-seconds', '30', ANALYSIS_SECONDS.map(String) as ('10' | '30' | '60')[]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const shown: { startedAt: number; seconds: number; result: Analysis } | undefined = state.state === 'done' ? state : state.state === 'idle' || state.state === 'running' ? state.last : undefined;
  const result = shown?.result, busy = result?.busyMs ?? 0, owner = (id: string) => result?.owners.find(o => o.id === id);
  // Helper processes are live: a plugin's own programs, and for this plugin its collector.
  const helpers = new Map<string, { cpu: number | null; memory: number | null }>();
  for (const p of programs(sample?.processes ?? [])) if (p.plugin) {
    const h = helpers.get(p.plugin) ?? { cpu: null, memory: null };
    helpers.set(p.plugin, { cpu: p.cpu === null ? h.cpu : (h.cpu ?? 0) + p.cpu, memory: p.memory === null ? h.memory : (h.memory ?? 0) + p.memory });
  }
  if (sample?.collector) helpers.set(SELF, { cpu: sample.collector.cpu, memory: sample.collector.memory });
  const rows = [...plugins].sort((a, b) => (owner(`plugin:${b.id}`)?.cpuMs ?? 0) - (owner(`plugin:${a.id}`)?.cpuMs ?? 0) || a.label.localeCompare(b.label, 'zh'));
  const running = state.state === 'running', elapsed = running ? Math.min(state.seconds, (Date.now() - state.startedAt) / 1000) : 0;

  return <section className="dpm-section dpm-plugins" aria-labelledby="dpm-plugins-title">
    <header className="dpm-section-head">
      <h2 id="dpm-plugins-title">插件</h2><span>后台 CPU 与内存按插件归属</span>
      <div className="dpm-plugins-actions">
        {running ? <>
          <span className="dpm-plugins-clock" role="status">正在分析，还剩 {Math.max(0, Math.ceil(state.seconds - elapsed))} 秒</span>
          <button type="button" className="dpm-button" onClick={() => void cancel()}>取消</button>
        </> : <>
          <Segmented label="分析时长" value={length} options={ANALYSIS_SECONDS.map(s => ({ value: String(s) as '10' | '30' | '60', label: `${s} 秒` }))} onChange={setLength} />
          <button type="button" className="dpm-button dpm-button-primary" onClick={() => void start(Number(length))}>{result ? '重新分析' : '开始分析'}</button>
        </>}
      </div>
    </header>
    {running && <div className="dpm-progress" aria-hidden="true"><i key={state.startedAt} style={{ animationDuration: `${state.seconds}s`, animationDelay: `-${elapsed}s` }} /></div>}
    <p className="dpm-plugins-meta">
      {error ? <span data-tone="danger">{error}</span>
        : state.state === 'failed' ? <span data-tone="danger">分析失败：{state.error}</span>
        : running ? '期间照常使用 DSH——让 Agent 工作、打开插件页面——结果更能反映实际占用。'
        : result && shown ? <>{clock(shown.startedAt)} 分析 {shown.seconds} 秒：后台主线程忙了 <b>{seconds(busy)}</b>（{share(busy, result.durationMs)}）{result.memory !== null && <>，新增且仍占用的内存约 <b>{bytes(result.memory)}</b></>}。占比是各部分占忙碌时间的比例。</>
        : '插件都运行在 DSH 后台进程里，系统无法把它们分开计量。分析会在后台采样调用栈，把 CPU 时间和新分配的内存归到代码所属的插件。'}
    </p>
    <table className="dpm-table dpm-plugin-table" data-stale={running || undefined}>
      <colgroup><col /><col className="dpm-col-share" /><col className="dpm-col-alloc" /><col className="dpm-col-helpers" /></colgroup>
      <thead><tr><th scope="col">名称</th><th scope="col">后台 CPU</th><th scope="col">新增内存</th><th scope="col">自带进程</th></tr></thead>
      <tbody>
        {rows.map(p => <Row key={p.id} owner={owner(`plugin:${p.id}`)} label={p.label} note={`${p.label === p.id ? '' : `${p.id} · `}${p.version}`} busy={busy}
          helpers={helpers.get(p.id) ?? null} open={open.has(p.id)} onToggle={() => toggle(p.id)} />)}
        {!plugins.length && <tr><td colSpan={4} className="dpm-table-empty">没有读到已安装的插件。</td></tr>}
      </tbody>
      {result && <tbody className="dpm-plugin-rest">
        {(['core', 'gc', 'other'] as const).map(id => { const o = owner(id)!; return o && <Row key={id} owner={o} label={o.label}
          note={id === 'core' ? 'DSH 自身的代码' : id === 'gc' ? '回收不再使用的内存' : '原生代码与无法归属的依赖'} busy={busy} helpers={null} open={open.has(id)} onToggle={() => toggle(id)} />; })}
      </tbody>}
    </table>
  </section>;
});
