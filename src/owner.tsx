import React, { useEffect, useState } from 'react';
import { call } from './api';
import { PROFILER, REST, type Hot, type OwnerDetail, type PluginInfo, type Sample } from './contracts';
import { MiniChart, stats } from './details';
import { bytes, change, clock, clockShort, cpu } from './format';
import { programName, programs } from './insights';
import { REST_LABEL } from './labels';
import { helpersOf } from './plugin-section';
import { ownerKey, type Tracked } from './tracking';
import { Dialog } from './ui';

const MB = 1024 ** 2;
const seconds = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} 秒` : `${Math.round(ms)} ms`;
const PLUGIN_ABOUT = '插件在后台主线程上运行的代码，以及它同步调用的 DSH 代码。它发起、由 DSH 稍后异步完成的工作（例如等待中的模型请求）算作 DSH 内核；文件和网络读写不在主线程，不计入。内存是 DSH 启动以来它分配、目前仍被占用的部分，为抽样估算。';

function HotList({ title, items, format, empty }: { title: string; items?: Hot[]; format(value: number): string; empty: string }) {
  return <div className="dpm-hot"><h4>{title}</h4>{!items ? <p>正在读取…</p> : items.length ? <ol>{items.map(h => <li key={h.name + h.where}>
    <span className="dpm-hot-name"><code>{h.name}</code>{h.where && <small>{h.where}</small>}</span><b>{format(h.value)}</b>
  </li>)}</ol> : <p>{empty}</p>}</div>;
}

/**
 * One owner of the Host's main thread (a plugin, DSH, garbage collection or the rest): its trend from the readings, and from
 * the Host where its time went over the range and where its memory sits, asked again every 15 seconds while open.
 */
export function OwnerDetails({ id, plugins, sample, tracked, start, end, onClose }: {
  id: string; plugins: PluginInfo[]; sample?: Sample; tracked: Tracked; start: number; end: number; onClose(): void;
}) {
  const plugin = id.startsWith('plugin:') ? plugins.find(p => `plugin:${p.id}` === id) : undefined, rest = REST_LABEL[id as typeof REST[number]];
  const name = plugin?.label ?? rest?.label ?? id.replace(/^plugin:/, ''), series = tracked.series.get(ownerKey(id)), s = stats(series, start);
  const split = sample?.attribution, now = split?.cpu?.[id] ?? null, held = id === 'gc' ? null : split?.memory?.owners[id] ?? null;
  const [detail, setDetail] = useState<OwnerDetail | null>(null), [error, setError] = useState(''), rangeKey = Math.round((end - start) / 60_000);
  useEffect(() => {
    let live = true;
    const load = () => call<OwnerDetail>('owner', { id, from: Date.now() - rangeKey * 60_000, to: Date.now() })
      .then(d => { if (live) { setDetail(d); setError(''); } }, e => { if (live) setError(e instanceof Error ? e.message : '读取失败'); });
    void load(); const timer = setInterval(load, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [id, rangeKey]);
  const pid = plugin?.id, own = pid ? programs(sample?.processes ?? []).filter(p => p.plugin === pid) : [], helper = pid ? helpersOf(sample).get(pid) : undefined;
  const collector = pid === 'dsh-performance' ? sample?.collector : null;

  return <Dialog title={name} className="dpm-sheet" onClose={onClose} lead={<i className="dpm-swatch" data-group="host" aria-hidden="true" />}>
    <p className="dpm-sheet-note">{plugin ? `${plugin.id} · ${plugin.version}` : rest?.note}</p>
    <div className="dpm-sheet-stats">
      <div><span>后台 CPU</span><strong>{cpu(now)}</strong><small>平均 {cpu(s.averageCpu)} · 峰值 {cpu(s.peakCpu)}</small></div>
      <div><span>内存</span><strong>{id === 'gc' ? '—' : bytes(held)}</strong>
        <small>{id === 'gc' ? '不占用内存' : split?.memory ? `${clockShort(split.memory.at)} 读取${s.memoryChange !== null ? ` · 变化 ${change(s.memoryChange)}` : ''}` : '尚未读取'}</small></div>
    </div>
    <MiniChart series={series} field="cpu" start={start} end={end} group="host" label="后台 CPU" />
    {id !== 'gc' && <MiniChart series={series} field="memory" start={start} end={end} group="host" label={`内存（每 ${PROFILER.memoryEveryMs / 60_000} 分钟读取）`} floor={2 * MB} />}
    {error ? <p className="dpm-sheet-error">{error}</p> : <>
      <HotList title={plugin ? '最耗时的函数' : '最忙的模块'} items={detail?.cpu} format={seconds} empty="所选时间范围内没有记录到" />
      {id !== 'gc' && <HotList title={plugin ? '占用内存最多的位置' : '占用内存最多的模块'} items={detail?.memory} format={bytes} empty={detail?.memoryAt ? '最近一次读取中没有' : '尚未读取内存'} />}
    </>}
    {(own.length > 0 || collector) && <table className="dpm-members">
      <caption>自带进程{helper ? ` · ${cpu(helper.cpu)} · ${bytes(helper.memory)}` : ''}</caption>
      <thead><tr><th scope="col">进程</th><th scope="col">CPU</th><th scope="col">内存</th></tr></thead>
      <tbody>
        {own.map(p => <tr key={p.key}><th scope="row"><strong>{programName(p.lead.name)}</strong><small>PID {p.lead.pid}{p.members.length > 1 ? ` · ${p.members.length} 个进程` : ''}</small></th>
          <td>{cpu(p.cpu)}</td><td>{bytes(p.memory)}</td></tr>)}
        {collector && <tr><th scope="row"><strong>采集器</strong><small>PID {collector.pid} · 读取进程信息，闲置 15 秒后退出</small></th><td>{cpu(collector.cpu)}</td><td>{bytes(collector.memory)}</td></tr>}
      </tbody>
    </table>}
    <p className="dpm-sheet-about">{plugin ? PLUGIN_ABOUT : rest?.about}</p>
    <p className="dpm-sheet-time">{sample ? `读数更新于 ${clock(sample.time)}` : ''}</p>
  </Dialog>;
}
