import React, { memo, useState } from 'react';
import type { Group, PluginInfo, ProcessMetric, Sample } from './contracts';
import { bytes, clockShort, cpu, span } from './format';
import { ArrowDown, Chevron } from './icons';
import { byUsage, commandSummary, keyOf, programName, programs, type SortKey } from './insights';
import { KIND } from './labels';
import { Sparkline } from './spark';
import type { ProgramRecord, Tracked } from './tracking';
import { useSteadyOrder } from './ui';

interface Row { key: string; group: Group; name: string; note: string; title?: string; cpu: number | null; memory: number | null; ended?: ProgramRecord }
function Usage({ value, total }: { value: number | null; total: number | null }) {
  const share = value !== null && total ? Math.min(100, value / total * 100) : 0;
  return <span className="dpm-usage"><span className="dpm-usage-bar" aria-hidden="true"><i style={{ width: `${share}%` }} /></span>{bytes(value)}</span>;
}

export const Processes = memo(function Processes({ sample, tracked, start, end, stale, plugins, onFocus, onOpen }: {
  sample?: Sample; tracked: Tracked; start: number; end: number; stale: boolean; plugins: PluginInfo[]; onFocus(group: Group | null): void; onOpen(key: string): void;
}) {
  const [sort, setSort] = useState<SortKey>('memory'), [held, setHeld] = useState(false), [showEnded, setShowEnded] = useState(false);
  const own: Row[] = (sample?.processes ?? []).filter(p => p.kind !== 'tool').map((p: ProcessMetric) => ({
    key: keyOf(p), group: p.group, name: KIND[p.kind].label, note: `${p.kind === 'utility' && p.detail ? p.detail.split('.').at(-1)! : KIND[p.kind].note} · PID ${p.pid}`, cpu: p.cpu, memory: p.memory,
  })).sort(byUsage(sort));
  const running = programs(sample?.processes ?? []);
  const tools: Row[] = running.map(t => ({
    key: t.key, group: 'tools' as const, name: programName(t.lead.name), title: t.lead.detail ?? undefined, cpu: t.cpu, memory: t.memory,
    note: `${t.plugin ? `插件「${plugins.find(p => p.id === t.plugin)?.label ?? t.plugin}」的程序 · ` : ''}${commandSummary(t.lead.detail) || t.lead.name}${t.members.length > 1 ? ` · ${t.members.length} 个进程` : ''} · PID ${t.lead.pid}`,
  })).sort(byUsage(sort));
  const live = new Set(running.map(t => t.key));
  const ended = tracked.programs.filter(r => r.ended !== null && !live.has(r.key) && r.ended >= start).sort((a, b) => b.ended! - a.ended!);
  // An agent runs the same command again and again: one row per command, opening its latest run.
  const repeats = new Map<string, { latest: ProgramRecord; count: number; totalMs: number; peakMemory: number | null }>();
  for (const r of ended) {
    const id = `${r.name}\u0000${r.summary}`, seen = repeats.get(id), ms = r.ended! - r.started;
    if (!seen) repeats.set(id, { latest: r, count: 1, totalMs: ms, peakMemory: r.peakMemory });
    else Object.assign(seen, { count: seen.count + 1, totalMs: seen.totalMs + ms, peakMemory: Math.max(seen.peakMemory ?? 0, r.peakMemory ?? 0) });
  }
  const order = useSteadyOrder([...own, ...tools].map(r => r.key), held), rank = new Map(order.map((k, i) => [k, i]));
  const placed = (rows: Row[]) => [...rows].sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  const total = sample?.memory ?? null;
  const header = (key: SortKey, label: string) => <th scope="col" aria-sort={sort === key ? 'descending' : undefined}>
    <button type="button" className="dpm-sort" data-active={sort === key || undefined} onClick={() => setSort(key)} title={`按${label}从高到低排序`}>{label}<ArrowDown size={12} /></button>
  </th>;
  const row = (r: Row) => <tr key={r.key} data-group={r.group} data-ended={r.ended ? '' : undefined} onClick={() => onOpen(r.key)}
    onPointerEnter={() => onFocus(r.group)} onPointerLeave={() => onFocus(null)}>
    <th scope="row"><button type="button" className="dpm-name" onClick={event => { event.stopPropagation(); onOpen(r.key); }} title={r.title}>
      <i className="dpm-swatch" data-group={r.group} aria-hidden="true" />
      <span className="dpm-name-text"><strong>{r.name}</strong><small>{r.note}</small></span>
    </button></th>
    <td className="dpm-trend-cell"><Sparkline series={tracked.series.get(r.key)} field={sort} start={start} end={end} group={r.group} /></td>
    <td>{r.ended ? '—' : cpu(r.cpu)}</td>
    <td>{r.ended ? <span className="dpm-peak">峰值 {bytes(r.memory)}</span> : <Usage value={r.memory} total={total} />}</td>
  </tr>;
  return <section className="dpm-section" aria-labelledby="dpm-processes-title" data-stale={stale || undefined}>
    <header className="dpm-section-head"><h2 id="dpm-processes-title">进程</h2><span>点击一行查看趋势与详情</span></header>
    <table className="dpm-table" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}>
      <colgroup><col /><col className="dpm-col-trend" /><col className="dpm-col-cpu" /><col className="dpm-col-memory" /></colgroup>
      <thead><tr><th scope="col">名称</th><th scope="col" className="dpm-trend-cell">{sort === 'cpu' ? 'CPU ' : '内存'}趋势</th>{header('cpu', 'CPU')}{header('memory', '内存')}</tr></thead>
      <tbody>
        <tr className="dpm-group-row"><th scope="rowgroup" colSpan={4}>DSH 应用<small>{own.length ? `${own.length} 个进程` : ''}</small></th></tr>
        {placed(own).map(row)}
        {!own.length && <tr><td colSpan={4} className="dpm-table-empty">{stale ? '暂时无法读取进程' : '正在读取 DSH 进程…'}</td></tr>}
      </tbody>
      <tbody>
        <tr className="dpm-group-row"><th scope="rowgroup" colSpan={4}>工具进程<small>{tools.length ? `${tools.length} 个运行中` : ''}</small></th></tr>
        {placed(tools).map(row)}
        {sample && !tools.length && <tr><td colSpan={4} className="dpm-table-empty">目前没有由 DSH 启动的程序。Agent 执行命令、打开终端或启动 MCP 服务后会出现在这里。</td></tr>}
        {!!ended.length && <tr className="dpm-ended-row"><td colSpan={4}>
          <button type="button" className="dpm-disclosure" aria-expanded={showEnded} onClick={() => setShowEnded(!showEnded)}>
            <Chevron size={14} />{`已退出 ${ended.length} 个`}<small>所选时间范围内</small>
          </button>
        </td></tr>}
        {showEnded && [...repeats.values()].map(({ latest: r, count, totalMs, peakMemory }) => row({
          key: r.key, group: 'tools', name: count > 1 ? `${r.name} × ${count}` : r.name, title: r.command ?? undefined, cpu: r.peakCpu, memory: peakMemory, ended: r,
          note: `${count > 1 ? `最近 ${clockShort(r.ended!)} · 共运行 ${span(totalMs)}` : `${clockShort(r.started)}–${clockShort(r.ended!)} · 运行 ${span(r.ended! - r.started)}`}${r.summary ? ` · ${r.summary}` : ''}` }))}
      </tbody>
    </table>
  </section>;
});
