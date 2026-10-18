import React, { useLayoutEffect, useRef, useState } from 'react';
import type { Group, ProcessMetric, Sample } from './contracts';
import { bytes, change, clock, clockShort, cpu, span } from './format';
import { Copy } from './icons';
import { commandSummary, firstTime, keyOf, programName, programs } from './insights';
import { KIND } from './labels';
import { trend } from './spark';
import type { Series, Tracked } from './tracking';
import { Dialog, copyText } from './ui';

/** Statistics of one series inside the range; CPU is the mean of the 15-second buckets. */
export function stats(series: Series | undefined, start: number) {
  if (!series) return { averageCpu: null, peakCpu: null, peakMemory: null, memoryChange: null };
  const from = firstTime(series.times, start);
  const cpus = series.cpu.slice(from).filter(v => !Number.isNaN(v)), memories = series.memory.slice(from).filter(v => !Number.isNaN(v));
  return {
    averageCpu: cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : null, peakCpu: cpus.length ? Math.max(...cpus) : null,
    peakMemory: memories.length ? Math.max(...memories) : null, memoryChange: memories.length > 1 ? memories.at(-1)! - memories[0] : null,
  };
}

/** One series as a small area chart across the range, with the reading under the pointer. */
export function MiniChart({ series, field, start, end, group, label, floor }: { series?: Series; field: 'cpu' | 'memory'; start: number; end: number; group: Group; label: string; floor?: number }) {
  const box = useRef<HTMLDivElement>(null), [width, setWidth] = useState(0), [at, setAt] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current!; setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth)); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const height = 84, t = trend(series, field, start, end, width, height, 6, floor), format = field === 'cpu' ? cpu : bytes;
  const index = at === null || !series ? -1 : (() => { const i = Math.min(firstTime(series.times, at), series.times.length - 1); return i > 0 && at - series.times[i - 1] < series.times[i] - at ? i - 1 : i; })();
  const value = index >= 0 ? series![field][index] : NaN, x = index >= 0 ? (series!.times[index] - start) / (end - start) * width : 0;
  return <figure className="dpm-mini">
    <figcaption><span>{label}</span><span className="dpm-mini-read">{index >= 0 && !Number.isNaN(value) ? <>{clock(series!.times[index])} · <b>{format(value)}</b></> : t.line ? `峰值 ${format(t.peak)}` : ''}</span></figcaption>
    <div ref={box} className="dpm-mini-plot" onPointerMove={event => setAt(start + (event.clientX - event.currentTarget.getBoundingClientRect().left) / width * (end - start))} onPointerLeave={() => setAt(null)}>
      {width > 0 && <svg width={width} height={height} data-group={group} aria-hidden="true">
        <line className="dpm-mini-base" x1={0} x2={width} y1={height - .5} y2={height - .5} />
        {t.area && <path className="dpm-spark-area" d={t.area} />}
        {t.line && <path className="dpm-spark-line" d={t.line} />}
        {index >= 0 && !Number.isNaN(value) && <><line className="dpm-cursor" x1={x} x2={x} y1={0} y2={height} />
          <circle className="dpm-marker" cx={x} cy={6 + (height - 12) * (1 - (value - t.min) / (t.max - t.min))} r={4} /></>}
      </svg>}
      {!t.line && <p className="dpm-mini-empty">这段时间还没有足够的读数</p>}
    </div>
    <div className="dpm-mini-axis"><span>{clockShort(start)}</span><span>{clockShort(end)}</span></div>
  </figure>;
}

function CommandLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <dd className="dpm-command"><code>{text}{text.length >= 1024 ? '…' : ''}</code>
    <button type="button" className="dpm-icon-button" aria-label={copied ? '已复制' : '复制命令行'} title={copied ? '已复制' : '复制命令行'}
      onClick={() => void copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => {})}><Copy /></button></dd>;
}

/** A DSH process, a running tool program or one that has ended, looked up by its key on every reading. */
export function Details({ id, sample, tracked, start, end, onClose }: { id: string; sample?: Sample; tracked: Tracked; start: number; end: number; onClose(): void }) {
  const own = sample?.processes.find(p => p.kind !== 'tool' && keyOf(p) === id);
  const program = own ? undefined : programs(sample?.processes ?? []).find(p => p.key === id);
  const record = tracked.programs.find(r => r.key === id), series = tracked.series.get(id), s = stats(series, start);
  const lead: ProcessMetric | undefined = own ?? program?.lead;
  const name = own ? KIND[own.kind].label : program ? programName(program.lead.name) : record?.name ?? '已退出的进程';
  const group: Group = own?.group ?? 'tools', kind = own?.kind ?? 'tool';
  const command = program?.lead.detail ?? record?.command ?? null;
  const startedAt = own?.created ?? program?.members[0].created ?? record?.started;
  const running = !!(own || program), current = own ?? program;
  return <Dialog title={name} className="dpm-sheet" onClose={onClose} lead={<i className="dpm-swatch" data-group={group} aria-hidden="true" />}>
    <p className="dpm-sheet-note">{kind === 'tool' ? commandSummary(command) || KIND.tool.note : KIND[kind].note}</p>
    <p className="dpm-sheet-state" data-running={running || undefined}>
      <i />{running ? `运行中${startedAt ? ` · 已运行 ${span(Date.now() - startedAt)}` : ''}`
        : record?.ended ? `已退出 · ${clockShort(record.started)}–${clockShort(record.ended)} · 运行 ${span(record.ended - record.started)}` : '已退出'}
    </p>
    <div className="dpm-sheet-stats">
      <div><span>CPU</span><strong>{running ? cpu(current!.cpu) : '—'}</strong><small>平均 {cpu(s.averageCpu)} · 峰值 {cpu(record && !running ? record.peakCpu : s.peakCpu)}</small></div>
      <div><span>内存</span><strong>{running ? bytes(current!.memory) : '—'}</strong>
        <small>峰值 {bytes(record && !running ? record.peakMemory : s.peakMemory)}{s.memoryChange !== null ? ` · 变化 ${change(s.memoryChange)}` : ''}</small></div>
    </div>
    <MiniChart series={series} field="cpu" start={start} end={end} group={group} label="CPU" />
    <MiniChart series={series} field="memory" start={start} end={end} group={group} label="内存" />
    <p className="dpm-sheet-about">{KIND[kind].about}</p>
    <dl className="dpm-facts">
      {lead && <><dt>PID</dt><dd>{lead.pid}{own || !program ? '' : `（共 ${program.members.length} 个进程）`}</dd></>}
      {lead && <><dt>父进程</dt><dd>{lead.parent}</dd></>}
      {startedAt && <><dt>启动于</dt><dd>{new Date(startedAt).toLocaleString('zh-CN', { hourCycle: 'h23' })}</dd></>}
      {lead && <><dt>线程</dt><dd>{program ? program.members.reduce((n, p) => n + p.threads, 0) : lead.threads}</dd></>}
      {command && <><dt>命令行</dt><CommandLine text={command} /></>}
    </dl>
    {program && program.members.length > 1 && <table className="dpm-members">
      <caption>包含的进程</caption>
      <thead><tr><th scope="col">进程</th><th scope="col">CPU</th><th scope="col">内存</th></tr></thead>
      <tbody>{program.members.map(p => <tr key={keyOf(p)}>
        <th scope="row"><strong>{programName(p.name)}</strong><small title={p.detail ?? undefined}>{commandSummary(p.detail) || p.name} · PID {p.pid}</small></th>
        <td>{cpu(p.cpu)}</td><td>{bytes(p.memory)}</td></tr>)}</tbody>
    </table>}
    <p className="dpm-sheet-time">{sample ? `读数更新于 ${clock(sample.time)}` : ''}</p>
  </Dialog>;
}
