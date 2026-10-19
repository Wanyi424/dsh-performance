import React, { memo, useState } from 'react';
import { foldKey, type Breakdown, type Row } from './breakdown';
import type { Group } from './contracts';
import { bytes, cpu } from './format';
import { ArrowDown, Chevron } from './icons';
import type { SortKey } from './insights';
import { Sparkline } from './spark';
import { useSteadyOrder } from './ui';

const MB = 1024 ** 2;

/**
 * 「谁在占用」: one table, DSH by part and then the programs it started, each with its trend, its average CPU over the range and
 * its memory now. A row opens its details in the drawer; the caret before it opens its parts in place. The Host opens into its
 * plugins, those that barely use anything folded into one line; programs that ended wait behind a disclosure at the bottom.
 */
export const UsageList = memo(function UsageList({ data, ready, sort, onSort, start, end, rangeLabel, expanded, onToggle, endedOpen, onEnded, active, stale, onOpen, onFocus }: {
  data: Breakdown; ready: boolean; sort: SortKey; onSort(key: SortKey): void; start: number; end: number; rangeLabel: string;
  expanded: ReadonlySet<string>; onToggle(key: string): void; endedOpen: boolean; onEnded(): void; active: string | null; stale: boolean;
  onOpen(key: string): void; onFocus(group: Group | null): void;
}) {
  // While the pointer is over the table the rows hold their places, so the one about to be clicked does not move away.
  const [held, setHeld] = useState(false), order = useSteadyOrder([...data.dsh, ...data.programs].map(r => r.key), held);
  const rank = new Map(order.map((key, i) => [key, i])), placed = (rows: Row[]) => [...rows].sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));

  const line = (row: Row, depth: 0 | 1) => {
    const open = expanded.has(row.key);
    return <tr key={row.key} className="dpm-row" data-group={row.group} data-depth={depth} data-quiet={row.quiet || undefined} data-ended={row.runs ? '' : undefined}
      data-active={active === row.key || undefined} onClick={() => onOpen(row.key)} onPointerEnter={() => onFocus(row.group)} onPointerLeave={() => onFocus(null)}>
      <th scope="row"><div className="dpm-name">
        {depth === 0 && (row.children
          ? <button type="button" className="dpm-caret" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}${row.name}`} onClick={event => { event.stopPropagation(); onToggle(row.key); }}><Chevron size={14} /></button>
          : <span className="dpm-caret-space" />)}
        <i className="dpm-swatch" aria-hidden="true" />
        <button type="button" className="dpm-name-button" onClick={event => { event.stopPropagation(); onOpen(row.key); }}
          title={row.runs ? '已退出：CPU 是运行期间的平均，内存是峰值' : undefined}>
          <strong><span>{row.name}</span>{row.tag && <span className="dpm-tag">{row.tag}</span>}</strong>
          {row.note && <small>{row.note}</small>}
        </button>
      </div></th>
      <td className="dpm-trend-cell"><Sparkline series={row.series} field={sort} start={start} end={end} group={row.group} floor={row.estimate ? 2 * MB : undefined} /></td>
      <td className="dpm-num" data-muted={row.cpu === null || undefined}>{cpu(row.cpu)}</td>
      <td className="dpm-num">{row.memory !== null && (row.runs || row.estimate) && <small>{row.runs ? '峰值' : '约'}</small>}{bytes(row.memory)}</td>
      <td className="dpm-go" aria-hidden="true"><Chevron size={14} /></td>
    </tr>;
  };
  const lines = (rows: Row[]) => rows.flatMap(row => {
    const out = [line(row, 0)];
    if (!row.children || !expanded.has(row.key)) return out;
    const fold = foldKey(row.key), open = expanded.has(fold), folded = row.folded ?? [];
    out.push(...row.children.filter(c => !c.quiet).map(c => line(c, 1)));
    if (folded.length) {
      out.push(<tr key={fold} className="dpm-fold-row"><td colSpan={5}><button type="button" className="dpm-disclosure" aria-expanded={open} onClick={() => onToggle(fold)}>
        <Chevron size={14} />{open ? `收起 ${folded.length} 个几乎不占用的插件` : `另外 ${folded.length} 个插件几乎不占用`}</button></td></tr>);
      if (open) out.push(...folded.map(c => line(c, 1)));
    }
    out.push(...row.children.filter(c => c.quiet).map(c => line(c, 1)));
    return out;
  });
  const header = (key: SortKey, label: string) => <th scope="col" aria-sort={sort === key ? 'descending' : 'none'}>
    <button type="button" className="dpm-sort" aria-pressed={sort === key} title={`按${label}从高到低排列`} onClick={() => onSort(key)}>{label}<ArrowDown size={12} /></button>
  </th>;

  return <section className="dpm-card" aria-labelledby="dpm-usage-title" data-stale={stale || undefined}>
    <header className="dpm-card-head"><h2 id="dpm-usage-title">谁在占用</h2><span className="dpm-hint">CPU 为 {rangeLabel}内的平均，内存为当前值 · 点一行查看详情</span></header>
    <table className="dpm-table" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}>
      <colgroup><col /><col className="c-trend" /><col className="c-cpu" /><col className="c-mem" /><col className="c-go" /></colgroup>
      <thead><tr><th scope="col">名称</th><th scope="col" className="dpm-trend-cell">{sort === 'cpu' ? 'CPU' : '内存'}趋势</th>{header('cpu', 'CPU')}{header('memory', '内存')}<td /></tr></thead>
      <tbody>
        <tr className="dpm-section-row"><th scope="rowgroup" colSpan={5}>DSH 各部分</th></tr>
        {data.dsh.length ? lines(placed(data.dsh)) : <tr className="dpm-empty-row"><td colSpan={5}>{ready ? '读不到 DSH 的进程。' : '正在读取…'}</td></tr>}
      </tbody>
      <tbody>
        <tr className="dpm-section-row"><th scope="rowgroup" colSpan={5}>DSH 启动的程序{data.programs.length > 0 && <small>{data.programs.length} 个运行中</small>}</th></tr>
        {lines(placed(data.programs))}
        {ready && !data.programs.length && <tr className="dpm-empty-row"><td colSpan={5}>目前没有。Agent 执行命令、打开终端或启动 MCP 服务后，会出现在这里。</td></tr>}
        {data.ended.length > 0 && <tr className="dpm-ended-row"><td colSpan={5}><button type="button" className="dpm-disclosure" aria-expanded={endedOpen} onClick={onEnded}>
          <Chevron size={14} />已退出的程序 {data.endedCount} 个<small>{rangeLabel}内</small></button></td></tr>}
        {endedOpen && lines(data.ended)}
      </tbody>
    </table>
  </section>;
});
