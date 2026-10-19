import React, { useLayoutEffect, useRef, useState } from 'react';
import type { Row } from './breakdown';
import type { Group, PluginInfo, Point, ProcessMetric, Sample } from './contracts';
import { bytes, change, clock, clockShort, cpu, dateTime, span } from './format';
import { Check, Copy } from './icons';
import { commandSummary, firstTime, keyOf, programName, programTitle, programs, sum } from './insights';
import { GROUP_ABOUT, GROUP_LABEL, KIND } from './labels';
import type { ResponseLog } from './responsiveness';
import { trend } from './spark';
import { groupKey, ownerKey, seriesStats, type Series, type Tracked } from './tracking';
import { Figure, copyText } from './ui';

/** What every view in the drawer reads: the latest readings, the range, and the list's own rows, so both show the same figures. */
export interface View {
  sample?: Sample; points: Point[]; response: ResponseLog; tracked: Tracked; plugins: readonly PluginInfo[];
  start: number; end: number; rangeLabel: string; rows: ReadonlyMap<string, Row>;
}

/** A view's title block: what it is, one line about it, and its state. The title takes focus when the drawer opens on it. */
export function Head({ group, title, meta, children }: { group?: Group; title: string; meta?: React.ReactNode; children?: React.ReactNode }) {
  return <header className="dpm-drawer-head">
    <h2 tabIndex={-1}>{group && <i className="dpm-swatch" data-group={group} aria-hidden="true" />}{title}</h2>
    {meta && <p className="dpm-drawer-meta">{meta}</p>}
    {children && <div className="dpm-chips">{children}</div>}
  </header>;
}
export const Chip = ({ state, children }: { state?: 'running' | 'paused'; children: React.ReactNode }) =>
  <span className="dpm-chip" data-state={state}>{state && <i aria-hidden="true" />}{children}</span>;
export function Block({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <section className="dpm-block"><div className="dpm-block-head"><h3>{title}</h3>{hint && <span>{hint}</span>}</div>{children}</section>;
}
export function Figures({ items }: { items: { label: string; value: string; sub: string }[] }) {
  return <div className="dpm-figures">{items.map(item => <div key={item.label} className="dpm-figure">
    <span>{item.label}</span><strong><Figure text={item.value} /></strong><em>{item.sub}</em>
  </div>)}</div>;
}
/** The two figures a part, a process or a program opens with: CPU over the range against now, memory now against the range. */
export function usage(stats: ReturnType<typeof seriesStats>, rangeLabel: string, average: number | null, cpuNow: number | null, memoryNow: number | null, over = `${rangeLabel}平均`) {
  return [
    { label: `CPU · ${over}`, value: cpu(average ?? stats.averageCpu), sub: `现在 ${cpu(cpuNow)} · 峰值 ${cpu(stats.peakCpu)}` },
    { label: '内存 · 现在', value: bytes(memoryNow),
      sub: stats.peakMemory === null ? '还没有足够的读数' : `${stats.memoryChange !== null ? `${rangeLabel}内 ${change(stats.memoryChange)} · ` : ''}峰值 ${bytes(stats.peakMemory)}` },
  ];
}

/** CPU and memory of one series across the range, one above the other, read at the same moment under the pointer. */
export function Charts({ series, group, start, end, memory = '内存', floor }: { series?: Series; group: Group; start: number; end: number; memory?: string | null; floor?: number }) {
  const [at, setAt] = useState<number | null>(null);
  return <div className="dpm-charts">
    <MiniChart series={series} field="cpu" label="CPU" group={group} start={start} end={end} at={at} onAt={setAt} />
    {memory && <MiniChart series={series} field="memory" label={memory} group={group} start={start} end={end} at={at} onAt={setAt} floor={floor} />}
  </div>;
}
function MiniChart({ series, field, label, group, start, end, at, onAt, floor }: {
  series?: Series; field: 'cpu' | 'memory'; label: string; group: Group; start: number; end: number; at: number | null; onAt(time: number | null): void; floor?: number;
}) {
  const box = useRef<HTMLDivElement>(null), [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current!; setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth)); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const height = 84, t = trend(series, field, start, end, width, height, 6, floor), format = field === 'cpu' ? cpu : bytes;
  const index = at === null || !series?.times.length ? -1 : (() => { const i = Math.min(firstTime(series.times, at), series.times.length - 1); return i > 0 && at - series.times[i - 1] < series.times[i] - at ? i - 1 : i; })();
  const value = index >= 0 ? series![field][index] : NaN, x = index >= 0 ? (series!.times[index] - start) / (end - start) * width : 0;
  const shown = index >= 0 && !Number.isNaN(value) && series!.times[index] >= start;
  return <figure className="dpm-mini" data-group={group}>
    <figcaption><span>{label}</span><span className="dpm-mini-read">{shown ? <>{clock(series!.times[index])} · <b>{format(value)}</b></> : t.line ? <>峰值 <b>{format(t.peak)}</b></> : ''}</span></figcaption>
    <div ref={box} className="dpm-mini-plot" onPointerMove={event => onAt(start + (event.clientX - event.currentTarget.getBoundingClientRect().left) / width * (end - start))} onPointerLeave={() => onAt(null)}>
      {width > 0 && <svg width={width} height={height} aria-hidden="true">
        <line className="dpm-mini-base" x1={0} x2={width} y1={height - .5} y2={height - .5} />
        {t.area && <path className="dpm-mini-area" d={t.area} />}
        {t.line && <path className="dpm-mini-line" d={t.line} />}
        {shown && <><line className="dpm-cursor" x1={x} x2={x} y1={0} y2={height} />
          <circle className="dpm-marker" cx={x} cy={6 + (height - 12) * (1 - (value - t.min) / (t.max - t.min))} r={3.5} /></>}
      </svg>}
      {!t.line && <p className="dpm-mini-empty">这段时间还没有足够的读数</p>}
    </div>
    <div className="dpm-mini-axis"><span>{clockShort(start)}</span><span>{clockShort(end)}</span></div>
  </figure>;
}

/** Plain facts, technical ones included: each label says in words what the value is. */
export function Facts({ items }: { items: ([string, React.ReactNode] | false | null | undefined | 0 | '')[] }) {
  return <dl className="dpm-facts">{items.flatMap(item => item ? [<React.Fragment key={item[0]}><dt>{item[0]}</dt><dd>{item[1]}</dd></React.Fragment>] : [])}</dl>;
}
function CommandLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="dpm-code"><code>{text}{text.length >= 1024 ? '…' : ''}</code>
    <button type="button" className="dpm-icon-button" aria-label={copied ? '已复制' : '复制命令行'} title={copied ? '已复制' : '复制命令行'}
      onClick={() => void copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => {})}>{copied ? <Check /> : <Copy />}</button></div>;
}
export interface Member { key: string; name: string; note: string; cpu: number | null; memory: number | null; open?: boolean }
/** What something is made of, as a small table; a line with details of its own opens them one level deeper. */
export function Members({ rows, onOpen }: { rows: Member[]; onOpen?(key: string): void }) {
  return <table className="dpm-members">
    <thead><tr><th scope="col">名称</th><th scope="col">CPU</th><th scope="col">内存</th></tr></thead>
    <tbody>{rows.map(r => {
      const go = r.open && onOpen ? () => onOpen(r.key) : undefined;
      return <tr key={r.key || r.name} data-link={go ? '' : undefined} onClick={go}>
        <th scope="row">{go ? <button type="button" className="dpm-member-link" onClick={event => { event.stopPropagation(); go(); }}><strong>{r.name}</strong><small>{r.note}</small></button>
          : <><strong>{r.name}</strong><small title={r.note}>{r.note}</small></>}</th>
        <td>{cpu(r.cpu)}</td><td>{bytes(r.memory)}</td>
      </tr>;
    })}</tbody>
  </table>;
}
export const Updated = ({ sample }: { sample?: Sample }) => sample ? <p className="dpm-drawer-time">读数更新于 {clock(sample.time)}</p> : null;
const processFacts = (p: ProcessMetric) => <Facts items={[['进程号（PID）', p.pid], ['父进程', p.parent], p.detail && ['进程类型', p.detail], ['启动于', dateTime(p.created)], ['线程数', p.threads]]} />;
const busiest = (a: { cpu: number | null }, b: { cpu: number | null }) => (b.cpu ?? -1) - (a.cpu ?? -1);

/** One part of DSH, or everything it started: what it does, its figures and trend, and the processes or programs behind it. */
export function GroupView({ group, view, onOpen }: { group: Group; view: View; onOpen(key: string): void }) {
  const { sample, tracked, start, end, rangeLabel } = view, series = tracked.series.get(groupKey(group)), stats = seriesStats(series, start);
  const members = sample?.processes.filter(p => p.group === group && p.kind !== 'tool').sort(busiest) ?? [];
  const running = group === 'tools' ? programs(sample?.processes ?? []).sort(busiest) : [];
  const parts: { cpu: number | null; memory: number | null }[] = group === 'tools' ? running : members;
  const total = (field: 'cpu' | 'memory') => { const v = parts.flatMap(p => p[field] === null ? [] : [p[field]!]); return v.length ? sum(v) : null; };
  const ended = group === 'tools' ? tracked.programs.filter(r => r.ended !== null && r.ended >= start).length : 0;
  return <>
    <Head group={group} title={GROUP_LABEL[group]} meta={GROUP_ABOUT[group].note}>
      {group === 'tools' ? <Chip>{running.length} 个运行中</Chip> : members.length > 1 ? <Chip>{members.length} 个进程</Chip> : members[0] && <Chip>PID {members[0].pid}</Chip>}
    </Head>
    <p className="dpm-about-text">{GROUP_ABOUT[group].about}</p>
    <Figures items={usage(stats, rangeLabel, view.rows.get(groupKey(group))?.cpu ?? null, total('cpu'), total('memory'))} />
    <Block title="趋势" hint={rangeLabel}><Charts series={series} group={group} start={start} end={end} /></Block>
    {group === 'tools' ? <Block title="正在运行" hint={running.length ? '点一行查看' : undefined}>
      {running.length ? <Members onOpen={onOpen} rows={running.map(p => {
        const summary = commandSummary(p.lead.detail);
        return { key: p.key, open: true, name: programTitle(programName(p.lead.name), summary), cpu: p.cpu, memory: p.memory,
          note: [summary || p.lead.name, p.shell && `在 ${programName(p.shell.name)} 中运行`].filter(Boolean).join(' · ') };
      })} /> : <p className="dpm-quiet">目前没有正在运行的程序。</p>}
      {ended > 0 && <p className="dpm-fine">{rangeLabel}内另有 {ended} 次运行已经退出，在「谁在占用」底部的「已退出的程序」里逐个查看。</p>}
    </Block>
      : members.length > 1 ? <Block title="包含的进程" hint="点一行查看"><Members onOpen={onOpen}
        rows={members.map(p => ({ key: keyOf(p), open: true, name: KIND[p.kind].label, note: `${KIND[p.kind].note} · PID ${p.pid}`, cpu: p.cpu, memory: p.memory }))} /></Block>
      : members[0] && <Block title="进程信息">{processFacts(members[0])}</Block>}
  </>;
}

/** A DSH process, a program DSH started, or one that has ended, looked up by its key on every reading. */
export function Details({ id, view, onOpen }: { id: string; view: View; onOpen(key: string): void }) {
  const { sample, tracked, plugins, start, end, rangeLabel } = view;
  const own = sample?.processes.find(p => p.kind !== 'tool' && keyOf(p) === id);
  const program = own ? undefined : programs(sample?.processes ?? []).find(p => p.key === id);
  const record = tracked.programs.find(r => r.key === id), series = tracked.series.get(id), stats = seriesStats(series, start), row = view.rows.get(id), now = sample?.time ?? Date.now();
  // Gone between readings (a process DSH restarted, an ended program that aged out): say so rather than guess what it was.
  if (!own && !program && !record) return <><Head title="已不在运行" /><p className="dpm-about-text">它已经退出，没有留下记录。</p></>;
  if (own) return <>
    <Head group={own.group} title={KIND[own.kind].label} meta={`${KIND[own.kind].note} · PID ${own.pid}`}><Chip state="running">运行中 · 已运行 {span(now - own.created)}</Chip></Head>
    <p className="dpm-about-text">{KIND[own.kind].about}</p>
    <Figures items={usage(stats, rangeLabel, row?.cpu ?? null, own.cpu, own.memory)} />
    <Block title="趋势" hint={rangeLabel}><Charts series={series} group={own.group} start={start} end={end} /></Block>
    <Block title="进程信息">{processFacts(own)}</Block>
  </>;

  const summary = program ? commandSummary(program.lead.detail) : record!.summary, lead = program?.lead, shell = program?.shell;
  const title = programTitle(program ? programName(program.lead.name) : record!.name, summary), plugin = program?.plugin ?? record?.plugin ?? null;
  const command = lead?.detail ?? record?.command ?? null, started = program?.members[0].created ?? record!.started, ended = program ? null : record?.ended ?? null;
  // A command that ran for a few seconds leaves a bucket or two: no trend to draw.
  const charted = !!program || (series?.times.filter(t => t >= start).length ?? 0) > 2, runs = row?.runs;
  return <>
    <Head group="tools" title={title} meta={[summary, shell && `在 ${programName(shell.name)} 中运行`].filter(Boolean).join(' · ') || undefined}>
      <Chip state={program ? 'running' : undefined}>{program ? `运行中 · 已运行 ${span(now - started)}` : ended ? `已退出 · ${clockShort(started)}–${clockShort(ended)} · 运行 ${span(ended - started)}` : '已退出'}</Chip>
      {plugin && <button type="button" className="dpm-chip" data-link="" onClick={() => onOpen(ownerKey(`plugin:${plugin}`))}>插件「{plugins.find(p => p.id === plugin)?.label ?? plugin}」的程序</button>}
    </Head>
    <p className="dpm-about-text">由 DSH 后台启动的程序{shell ? `，在 ${programName(shell.name)} 里运行，通常是 Agent 执行的命令，或你在终端里启动的` : ''}。它和它启动的子进程合并计算，计入 DSH 的合计。</p>
    <Figures items={program ? usage(stats, rangeLabel, row?.cpu ?? null, program.cpu, program.memory, started > start ? '运行期间平均' : `${rangeLabel}平均`) : [
      { label: 'CPU · 运行期间平均', value: cpu(stats.averageCpu), sub: `峰值 ${cpu(record?.peakCpu)}` },
      { label: '内存 · 峰值', value: bytes(record?.peakMemory), sub: ended ? `运行 ${span(ended - started)}` : '—' },
    ]} />
    {charted && <Block title="趋势" hint={rangeLabel}><Charts series={series} group="tools" start={start} end={end} /></Block>}
    {runs && runs.length > 1 && <Block title={`${rangeLabel}内运行了 ${runs.length} 次`} hint="最近的在前"><ol className="dpm-runs">
      {runs.slice(0, 10).map(r => <li key={r.key}><span>{clock(r.started)} 启动</span><span>运行 {span(r.ended! - r.started)}</span></li>)}
    </ol></Block>}
    {program && program.members.length > 1 && <Block title="包含的进程"><Members
      rows={program.members.map(p => ({ key: keyOf(p), name: programName(p.name), note: `${commandSummary(p.detail) || p.name} · PID ${p.pid}`, cpu: p.cpu, memory: p.memory }))} /></Block>}
    <Block title="技术信息"><Facts items={[
      ['进程号（PID）', lead ? (program!.members.length > 1 ? `${lead.pid}（共 ${program!.members.length} 个进程）` : lead.pid) : record!.pid],
      lead && ['父进程', lead.parent],
      ['启动于', dateTime(started)],
      program && ['线程数', sum(program.members.map(p => p.threads))],
      lead?.path && ['程序位置', <code className="dpm-path">{lead.path}</code>],
      command && ['命令行', <CommandLine text={command} />],
    ]} /></Block>
  </>;
}
