import React, { memo, useState } from 'react';
import { PROFILER, REST, type Group, type PluginInfo, type Point, type Sample } from './contracts';
import { bytes, clockShort, cpu } from './format';
import { ArrowDown } from './icons';
import { byUsage, ownerAverages, programs, sum, type SortKey } from './insights';
import { REST_LABEL } from './labels';
import { Sparkline } from './spark';
import { ownerKey, type Tracked } from './tracking';
import { useSteadyOrder } from './ui';

const SELF = 'dsh-performance', MB = 1024 ** 2;
interface Row { id: string; name: string; note: string; cpu: number | null; memory: number | null; helpers: { cpu: number | null; memory: number | null } | null }

/** The live helper processes of each plugin: programs started from its folder, and for this plugin its collector. */
export function helpersOf(sample?: Sample) {
  const helpers = new Map<string, { cpu: number | null; memory: number | null }>();
  for (const p of programs(sample?.processes ?? [])) if (p.plugin) {
    const h = helpers.get(p.plugin) ?? { cpu: null, memory: null };
    helpers.set(p.plugin, { cpu: p.cpu === null ? h.cpu : (h.cpu ?? 0) + p.cpu, memory: p.memory === null ? h.memory : (h.memory ?? 0) + p.memory });
  }
  if (sample?.collector) helpers.set(SELF, { cpu: sample.collector.cpu, memory: sample.collector.memory });
  return helpers;
}

/**
 * Plugins share DSH's Host process, so Windows cannot meter them apart; the Host profiles itself and splits its main thread
 * and memory by plugin with every reading. CPU is the average over the chosen range (one reading of a plugin is mostly
 * zero); memory is the latest reading, taken every few minutes. Their own helper processes are metered live.
 */
export const PluginSection = memo(function PluginSection({ plugins, sample, points, tracked, start, end, stale, onFocus, onOpen }: {
  plugins: PluginInfo[]; sample?: Sample; points: Point[]; tracked: Tracked; start: number; end: number; stale: boolean;
  onFocus(group: Group | null): void; onOpen(key: string): void;
}) {
  const [sort, setSort] = useState<SortKey>('cpu'), [held, setHeld] = useState(false);
  const split = sample?.attribution, averages = ownerAverages(points, start, end), helpers = helpersOf(sample);
  const row = (id: string, name: string, note: string, helper: Row['helpers']): Row => ({ id, name, note, helpers: helper, cpu: averages?.[id] ?? null, memory: id === 'gc' ? null : split?.memory?.owners[id] ?? null });
  const own = plugins.map(p => row(`plugin:${p.id}`, p.label, `${p.label === p.id ? '' : `${p.id} · `}${p.version}`, helpers.get(p.id) ?? null)).sort(byUsage(sort));
  const rest = REST.map(id => row(id, REST_LABEL[id].label, REST_LABEL[id].note, null));
  const order = useSteadyOrder(own.map(r => r.id), held), rank = new Map(order.map((id, i) => [id, i]));
  const header = (key: SortKey, label: string, title: string) => <th scope="col" aria-sort={sort === key ? 'descending' : undefined}>
    <button type="button" className="dpm-sort" data-active={sort === key || undefined} onClick={() => setSort(key)} title={title}>{label}<ArrowDown size={12} /></button>
  </th>;
  const line = (r: Row, muted = false) => <tr key={r.id} data-group="host" data-muted={muted || undefined} onClick={() => onOpen(`owner:${r.id}`)}
    onPointerEnter={() => onFocus('host')} onPointerLeave={() => onFocus(null)}>
    <th scope="row"><button type="button" className="dpm-name" onClick={event => { event.stopPropagation(); onOpen(`owner:${r.id}`); }}>
      <i className="dpm-swatch" data-group="host" aria-hidden="true" />
      <span className="dpm-name-text"><strong>{r.name}</strong><small>{r.note}</small></span>
    </button></th>
    <td className="dpm-trend-cell"><Sparkline series={tracked.series.get(ownerKey(r.id))} field={sort} start={start} end={end} group="host" floor={2 * MB} /></td>
    <td>{cpu(r.cpu)}</td>
    <td>{bytes(r.memory)}</td>
    <td className="dpm-helpers-cell">{r.helpers ? <span className="dpm-helpers">{cpu(r.helpers.cpu)} · {bytes(r.helpers.memory)}</span> : muted ? '' : '—'}</td>
  </tr>;
  // The sentence above the table: how busy the Host's main thread was over the range, and whose that time was.
  const total = averages ? sum(Object.values(averages)) : null, ofPlugins = averages ? sum(own.map(r => averages[r.id] ?? 0)) : null;
  const memory = split?.memory;

  return <section className="dpm-section dpm-plugins" aria-labelledby="dpm-plugins-title" data-stale={stale || undefined}>
    <header className="dpm-section-head"><h2 id="dpm-plugins-title">插件</h2><span>打开本页时按需分析后台主线程和内存，点击一行查看详情</span></header>
    <p className="dpm-plugins-meta">
      {/* Each sentence is one span: the line wraps between sentences, never inside one. */}
      {split?.error ? <span data-tone="danger">{split.error}</span> : <span>{!split ? '插件归属分析只在本页可见时开启；界面 Renderer 和 GPU 内存不归属到具体插件。'
        : total === null ? '正在开始统计，下一次读数后显示。'
        : <>所选时间范围内，后台主线程平均占整机 <b>{cpu(total)}</b>：插件 {cpu(ofPlugins)} · DSH 内核 {cpu(averages!.core)} · 垃圾回收 {cpu(averages!.gc)}。</>}</span>}
      {!split?.error && <span>{memory ? `内存 ${clockShort(memory.at)} 读取，每 ${PROFILER.memoryEveryMs / 60_000} 分钟一次。` : `内存在 DSH 启动约 ${PROFILER.firstMemoryMs / 60_000} 分钟后第一次读取。`}</span>}
    </p>
    <table className="dpm-table dpm-plugin-table" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}>
      <colgroup><col /><col className="dpm-col-trend" /><col className="dpm-col-cpu" /><col className="dpm-col-held" /><col className="dpm-col-helpers" /></colgroup>
      <thead><tr>
        <th scope="col">名称</th><th scope="col" className="dpm-trend-cell">{sort === 'cpu' ? 'CPU ' : '内存'}趋势</th>
        {header('cpu', '平均 CPU', '按所选时间范围内的平均 CPU 从高到低排序')}{header('memory', '内存', '按最近一次读取的内存从高到低排序')}
        <th scope="col" className="dpm-helpers-cell">自带进程</th>
      </tr></thead>
      <tbody>
        {[...own].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!).map(r => line(r))}
        {!plugins.length && <tr><td colSpan={5} className="dpm-table-empty">没有读到已安装的插件。</td></tr>}
      </tbody>
      <tbody className="dpm-plugin-rest">{rest.map(r => line(r, true))}</tbody>
    </table>
  </section>;
});
