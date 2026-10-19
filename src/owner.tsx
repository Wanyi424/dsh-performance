import React, { useEffect, useState } from 'react';
import { call } from './api';
import { miscOf, pointSeries, restOf } from './breakdown';
import { PROFILER, type Hot, type OwnerDetail } from './contracts';
import { Block, Charts, Chip, Facts, Figures, Head, Members, usage, type View } from './details';
import { bytes, clockShort, cpu, dateTime, duration } from './format';
import { Chevron, Pause, Play } from './icons';
import { commandSummary, hostSplit, programName, programTitle, programs } from './insights';
import { GROUP_ABOUT, OWNER_LABEL, PLUGIN_ABOUT, SELF, ownerName } from './labels';
import { groupKey, ownerKey, seriesStats } from './tracking';

const MB = 1024 ** 2;
type Part = { id: string; name: string; note?: string; cpu: number; quiet?: boolean };

/** Who used the Host's CPU over the range, each as a part of the whole; each line opens its own details one level deeper. */
function Split({ parts, total, onOpen }: { parts: Part[]; total: number; onOpen(key: string): void }) {
  return <ul className="dpm-split">{parts.map(p => <li key={p.id} data-quiet={p.quiet || undefined}>
    <button type="button" onClick={() => onOpen(ownerKey(p.id))}>
      <span className="dpm-split-name"><strong>{p.name}</strong>{p.note && <small>{p.note}</small>}</span>
      <span className="dpm-split-bar" aria-hidden="true"><i style={{ width: `${total > 0 ? Math.min(100, p.cpu / total * 100) : 0}%` }} /></span>
      <span className="dpm-split-value">{cpu(p.cpu)}</span><Chevron size={14} />
    </button>
  </li>)}</ul>;
}
function HotList({ items, format, empty }: { items?: Hot[]; format(value: number): string; empty: string }) {
  if (!items) return <p className="dpm-quiet">正在读取…</p>;
  return items.length ? <ol className="dpm-hot">{items.map(h => <li key={h.name + h.where}>
    <span className="dpm-hot-name"><code>{h.name}</code>{h.where && <small>{h.where}</small>}</span><b>{format(h.value)}</b>
  </li>)}</ol> : <p className="dpm-quiet">{empty}</p>;
}

/** The Host: what it does, where its CPU went over the range by plugin, the switch that pauses that split, its trend and process. */
export function HostView({ view, onOpen }: { view: View; onOpen(key: string): void }) {
  const { sample, points, tracked, plugins, start, end, rangeLabel } = view, a = sample?.attribution, [pending, setPending] = useState(false);
  const host = sample?.processes.find(p => p.kind === 'host'), series = tracked.series.get(groupKey('host')), split = hostSplit(points, start, end);
  const seen = !!split && Object.keys(split.owners).length > 0;
  const named: Part[] = seen ? plugins.map(p => ({ id: `plugin:${p.id}`, name: p.label, note: '插件', cpu: split!.owners[`plugin:${p.id}`] ?? 0 })).filter(p => p.cpu > 0).sort((x, y) => y.cpu - x.cpu) : [];
  const others: Part[] = !split ? [] : [
    ...seen ? (['core', 'gc', 'other'] as const).map(id => ({ id, name: OWNER_LABEL[id].label, note: OWNER_LABEL[id].note, cpu: split.owners[id] ?? 0, quiet: id !== 'core' })) : [],
    { id: 'rest', name: OWNER_LABEL.rest.label, note: OWNER_LABEL.rest.note, cpu: split.rest, quiet: true },
  ];
  const toggle = () => { setPending(true); void call('profiling', { enabled: a?.state !== 'running' }).catch(() => {}).finally(() => setPending(false)); };
  return <>
    <Head group="host" title="后台" meta={GROUP_ABOUT.host.note}>
      {host && <Chip>PID {host.pid}</Chip>}
      {a && <Chip state={a.state === 'running' ? 'running' : a.state === 'paused' ? 'paused' : undefined}>{a.state === 'running' ? '插件统计运行中' : a.state === 'paused' ? '插件统计已暂停' : '插件统计不可用'}</Chip>}
    </Head>
    <p className="dpm-about-text">{GROUP_ABOUT.host.about}</p>
    <Figures items={usage(seriesStats(series, start), rangeLabel, view.rows.get(groupKey('host'))?.cpu ?? null, host?.cpu ?? null, host?.memory ?? null)} />
    <Block title="后台的 CPU 花在哪里" hint={`${rangeLabel}平均 · 点一行查看`}>
      {a?.error ? <p className="dpm-error">{a.error}</p> : split ? <>
        <Split parts={[...named, ...others]} total={split.total} onOpen={onOpen} />
        {seen && plugins.length > named.length && <p className="dpm-fine">另外 {plugins.length - named.length} 个插件这段时间没有占用后台。</p>}
      </> : <p className="dpm-quiet">还没有读数，下一次读数后显示。</p>}
      {a && a.state !== 'unavailable' && <div className="dpm-profiler">
        <p>{a.state === 'running'
          ? <>插件统计<b>运行中</b>{a.since ? `，从 ${clockShort(a.since)} 开始` : ''}。每 {PROFILER.sampleMs} 毫秒记录一次后台正在运行的代码，开销很小；用 DevTools 调试后台时可以先暂停。</>
          : <>插件统计<b>已暂停</b>，后台的 CPU 暂时不按插件拆分，直到继续或 DSH 重启。继续时后台会短暂停顿一次。</>}</p>
        <button type="button" className="dpm-button" data-small="" disabled={pending} onClick={toggle}>{a.state === 'running' ? <><Pause size={14} />暂停统计</> : <><Play size={14} />继续统计</>}</button>
      </div>}
    </Block>
    <Block title="趋势" hint={rangeLabel}><Charts series={series} group="host" start={start} end={end} /></Block>
    {host && <Block title="进程信息"><Facts items={[['进程号（PID）', host.pid], ['父进程', host.parent], ['启动于', dateTime(host.created)], ['线程数', host.threads]]} /></Block>}
  </>;
}

/**
 * One owner of the Host's CPU: a plugin, DSH itself, garbage collection, other code, the rest, or the list's「其他」(the last
 * three together). Its figures come from the readings, like the list's; where its time went and where its memory sits come
 * from the Host, asked again every 15 seconds while it is open.
 */
export function OwnerView({ id, view, onOpen }: { id: string; view: View; onOpen(key: string): void }) {
  const { sample, points, tracked, plugins, start, end, rangeLabel } = view, a = sample?.attribution;
  const plugin = id.startsWith('plugin:') ? plugins.find(p => `plugin:${p.id}` === id) : undefined, info = OWNER_LABEL[id as keyof typeof OWNER_LABEL];
  // The rest and「其他」keep no series of their own: theirs comes from the readings.
  const computed = id === 'rest' || id === 'misc', pick = id === 'rest' ? restOf : miscOf;
  const series = computed ? pointSeries(points, start, pick) : tracked.series.get(ownerKey(id)), stats = seriesStats(series, start), split = hostSplit(points, start, end);
  const average = view.rows.get(ownerKey(id))?.cpu ?? (!split ? null : id === 'rest' ? split.rest : id === 'misc' ? (split.owners.gc ?? 0) + (split.owners.other ?? 0) + split.rest : split.owners[id] ?? null);
  const last = points.at(-1), now = computed ? (last ? pick(last) : null) : a?.cpu?.[id] ?? null;
  const held = id === 'gc' || id === 'rest' ? null : a?.memory?.owners[id === 'misc' ? 'other' : id] ?? null;
  // Garbage collection and the rest have no code of their own to point at.
  const hot = !computed && id !== 'gc', [detail, setDetail] = useState<OwnerDetail | null>(null), [error, setError] = useState(''), minutes = Math.round((end - start) / 60_000);
  useEffect(() => {
    if (!hot) return;
    let live = true;
    const load = () => call<OwnerDetail>('owner', { id, from: Date.now() - minutes * 60_000, to: Date.now() })
      .then(d => { if (live) { setDetail(d); setError(''); } }, e => { if (live) setError(e instanceof Error ? e.message : '读取失败'); });
    void load(); const timer = setInterval(load, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [id, minutes, hot]);
  const own = plugin ? programs(sample?.processes ?? []).filter(p => p.plugin === plugin.id) : [], collector = plugin?.id === SELF ? sample?.collector : null;
  const memorySub = id === 'gc' || id === 'rest' ? '不单独计算内存' : a?.memory ? `估算 · ${clockShort(a.memory.at)} 读取，每 ${PROFILER.memoryEveryMs / 60_000} 分钟一次`
    : `统计开始约 ${PROFILER.firstMemoryMs / 60_000} 分钟后第一次读取`;
  return <>
    <Head group="host" title={plugin?.label ?? info?.label ?? ownerName(id, plugins)}
      meta={plugin ? `${plugin.id}${plugin.version ? ` · v${plugin.version}` : ''}${plugin.id === SELF ? ' · 本插件' : ''}` : info?.note}>
      {plugin ? a && <Chip state={a.state === 'running' ? 'running' : a.state === 'paused' ? 'paused' : undefined}>{a.state === 'running' ? '插件统计运行中' : a.state === 'paused' ? '插件统计已暂停' : '插件统计不可用'}</Chip>
        : <Chip>后台的一部分</Chip>}
    </Head>
    <p className="dpm-about-text">{plugin ? PLUGIN_ABOUT : info?.about}</p>
    <Figures items={[
      { label: `后台 CPU · ${rangeLabel}平均`, value: cpu(average), sub: `现在 ${cpu(now)} · 峰值 ${cpu(stats.peakCpu)}` },
      { label: '内存', value: bytes(held), sub: memorySub },
    ]} />
    {id === 'misc' && split && <Block title="由三部分组成" hint={`${rangeLabel}平均 · 点一行查看`}><Split total={average ?? 0} onOpen={onOpen}
      parts={(['gc', 'other', 'rest'] as const).map(k => ({ id: k, name: OWNER_LABEL[k].label, note: OWNER_LABEL[k].note, cpu: k === 'rest' ? split.rest : split.owners[k] ?? 0, quiet: true }))} /></Block>}
    <Block title="趋势" hint={rangeLabel}><Charts series={series} group="host" start={start} end={end} floor={2 * MB}
      memory={id === 'gc' || computed ? null : `内存（每 ${PROFILER.memoryEveryMs / 60_000} 分钟读取）`} /></Block>
    {hot && (error ? <p className="dpm-error">{error}</p> : <>
      <Block title={plugin ? '最耗时的函数' : '最忙的代码包'} hint={`${rangeLabel}内合计`}><HotList items={detail?.cpu} format={duration} empty={`${rangeLabel}内没有记录到它在运行`} /></Block>
      <Block title={plugin ? '占用内存最多的位置' : '占用内存最多的代码包'} hint={detail?.memoryAt ? `${clockShort(detail.memoryAt)} 读取` : undefined}>
        <HotList items={detail?.memory} format={bytes} empty={detail?.memoryAt ? '最近一次读取中没有' : '还没有读取内存'} /></Block>
    </>)}
    {(own.length > 0 || collector) && <Block title="自带程序"><Members onOpen={onOpen} rows={[
      ...own.map(p => ({ key: p.key, open: true, name: programTitle(programName(p.lead.name), commandSummary(p.lead.detail)), note: `PID ${p.lead.pid}${p.members.length > 1 ? ` · ${p.members.length} 个进程` : ''}`, cpu: p.cpu, memory: p.memory })),
      ...collector ? [{ key: '', name: '采集器', note: `PID ${collector.pid} · 读取进程信息，不计入 DSH 合计`, cpu: collector.cpu, memory: collector.memory }] : [],
    ]} /></Block>}
    {plugin && a?.since && <p className="dpm-fine">内存是 {clockShort(a.since)} 起分配、仍在占用的部分（抽样估算）。比本插件更早加载的插件，启动时分配的内存不在其中；要准确比较，请停用该插件后重启 DSH 对比。</p>}
  </>;
}
