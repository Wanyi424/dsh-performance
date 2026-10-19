import React, { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GROUPS, type Group, type Point, type Sample } from './contracts';
import { bytes, clock, clockShort, cpu, duration, gb, span } from './format';
import { GAP_MS, SLOW_INTERACTION_MS, decimate, firstAt, programTitle, sum, summarizeResponse } from './insights';
import { GROUP_LABEL } from './labels';
import type { Frame, Interaction, ResponseLog } from './responsiveness';
import { groupKey, type ProgramRecord } from './tracking';
import { Figure, Tip } from './ui';

/** The shared canvas, top to bottom: three tracks, the lane of programs that started or stopped, and the time axis. */
const TRACK = { cpu: { top: 0, height: 118 }, memory: { top: 118, height: 118 }, response: { top: 236, height: 84 }, lane: { top: 320, height: 54 } };
const H = 396, X = 10, MB = 1024 ** 2, GB = 1024 ** 3;
/** Programs that ran at least this long draw as named bars; shorter ones, such as single commands, as ticks below them. */
const LONG_MS = 60_000;
/** The tooltip names the Host's busiest owners at the moment, down to this share of the machine. */
const OWNER_SHOWN = .05;
const CPU_STEPS = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];
const MEMORY_STEPS = [.25, .5, .75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64].map(n => n * GB);
const MS_STEPS = [100, 200, 300, 500, 1000, 1500, 2000, 5000, 10_000, 30_000];
const MINUTE_STEPS = [1, 2, 5, 10, 15, 30].map(n => n * 60_000);
const ceilTo = (steps: number[], value: number) => steps.find(step => step >= value) ?? steps.at(-1)!;
const axisBytes = (value: number) => value >= GB ? `${+(value / GB).toFixed(2)} GB` : `${Math.round(value / MB)} MB`;
const axisMs = (value: number) => value >= 1000 ? `${+(value / 1000).toFixed(1)} 秒` : `${Math.round(value)} 毫秒`;
/** Where a track draws: a little below its top edge, above its bottom. */
const plot = (track: { top: number; height: number }) => ({ top: track.top + 16, bottom: track.top + track.height - 10 });

function timeTicks(start: number, end: number) {
  const step = MINUTE_STEPS.find(s => (end - start) / s <= 6) ?? MINUTE_STEPS.at(-1)!, offset = new Date(start).getTimezoneOffset() * 60_000;
  const ticks: number[] = [];
  for (let t = Math.ceil((start - offset) / step) * step + offset; t <= end; t += step) ticks.push(t);
  return ticks;
}

/**
 * Stacked areas per group, each with its top edge as a line where the group has a value. A run ends at a missing value or a
 * gap; a break is never bridged.
 */
function stack(points: Point[], field: 'cpu' | 'memory', x: (t: number) => number, y: (v: number) => number, gap: number) {
  const areas = GROUPS.map(() => ''), lines = GROUPS.map(() => ''), runs: Point[][] = [];
  let run: Point[] = [];
  for (const p of points) {
    if (!p[field] || (run.length && p.time - run.at(-1)!.time > gap)) { if (run.length > 1) runs.push(run); run = []; }
    if (p[field]) run.push(p);
  }
  if (run.length > 1) runs.push(run);
  let last: { x: number; y: number; time: number } | null = null;
  for (const r of runs) {
    const xs = r.map(p => x(p.time).toFixed(1)), levels = r.map(p => { let total = 0; return p[field]!.map(v => total += v); });
    const edge = (g: number) => levels.map((l, k) => `${xs[k]},${(g < 0 ? y(0) : y(l[g])).toFixed(1)}`);
    GROUPS.forEach((_, g) => {
      const top = edge(g);
      areas[g] += `M${top.join('L')}L${edge(g - 1).reverse().join('L')}Z`;
      // An empty group has no edge of its own: its line would lie on the neighbour's and show through when that one recedes.
      let segment: string[] = [];
      r.forEach((p, k) => {
        if (p[field]![g] > 0) segment.push(top[k]);
        else { if (segment.length > 1) lines[g] += `M${segment.join('L')}`; segment = []; }
      });
      if (segment.length > 1) lines[g] += `M${segment.join('L')}`;
    });
    const end = r.at(-1)!; last = { x: x(end.time), y: y(sum(end[field]!)), time: end.time };
  }
  return { areas, lines, last };
}
function nearest<T extends { time: number }>(items: T[], from: number, to: number, time: number) {
  if (to <= from) return -1;
  const i = Math.min(Math.max(firstAt(items, time), from), to - 1);
  return i > from && time - items[i - 1].time < items[i].time - time ? i - 1 : i;
}

/**
 * CPU, memory and responsiveness on one time axis, with the programs that started or stopped below: one vertical line runs
 * through all of them, so what happened at one moment reads straight down. Beside each track is its value now and one line
 * that sets it in context. While a moment is inspected the window holds still, so it does not slide away.
 */
export const Timeline = memo(function Timeline({ points, response, programs, sample, start, end, rangeLabel, stale, ownerName, onOpen, onFocus }: {
  points: Point[]; response: ResponseLog; programs: readonly ProgramRecord[]; sample?: Sample; start: number; end: number; rangeLabel: string; stale: boolean;
  ownerName(id: string): string; onOpen(key: string): void; onFocus(group: Group | null): void;
}) {
  const canvas = useRef<HTMLDivElement>(null), [width, setWidth] = useState(0);
  const [held, setHeld] = useState<{ start: number; end: number } | null>(null), [at, setAt] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = canvas.current!; setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth)); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const view = held ?? { start, end }, spanMs = view.end - view.start, plotWidth = Math.max(0, width - X * 2);
  const x = (t: number) => X + (t - view.start) / spanMs * plotWidth;
  const from = firstAt(points, view.start), to = firstAt(points, view.end + 1);
  const { frames, interactions } = response;
  const fFrom = firstAt(frames, view.start), fTo = firstAt(frames, view.end + 1), iFrom = firstAt(interactions, view.start), iTo = firstAt(interactions, view.end + 1);

  const geometry = useMemo(() => {
    // About one drawn point per two pixels; a gap is wider than both the sampling break and a drawing bucket.
    const bucket = plotWidth ? spanMs / (plotWidth / 2) : spanMs, drawn = decimate(points, Math.max(0, from - 1), to, bucket), gap = Math.max(GAP_MS, bucket * 2.5);
    const track = (field: 'cpu' | 'memory', box: { top: number; height: number }) => {
      let peak = 0; for (let i = from; i < to; i++) { const v = points[i][field]; if (v) peak = Math.max(peak, sum(v)); }
      const max = field === 'cpu' ? ceilTo(CPU_STEPS, peak * 1.15) : ceilTo(MEMORY_STEPS, peak * 1.1), p = plot(box);
      const y = (v: number) => p.bottom - v / max * (p.bottom - p.top);
      return { max, y, ...stack(drawn, field, x, y, gap) };
    };
    let peak = 0;
    for (let i = fFrom; i < fTo; i++) peak = Math.max(peak, frames[i].duration);
    for (let i = iFrom; i < iTo; i++) peak = Math.max(peak, interactions[i].duration);
    const max = ceilTo(MS_STEPS, Math.max(peak * 1.15, 150)), p = plot(TRACK.response);
    return { cpu: track('cpu', TRACK.cpu), memory: track('memory', TRACK.memory), response: { max, y: (v: number) => p.bottom - Math.min(v, max) / max * (p.bottom - p.top) } };
  }, [points, frames, interactions, from, to, fFrom, fTo, iFrom, iTo, view.start, spanMs, plotWidth]);

  // The lane shows what started or stopped in view; a program running through the whole window has nothing to mark. Long runs
  // pack onto two rows of named bars, single commands become ticks below them.
  const lanes = useMemo(() => {
    const rows = [-Infinity, -Infinity];
    return [...programs].sort((a, b) => a.started - b.started).flatMap(r => {
      const until = r.ended ?? view.end;
      if (until < view.start || r.started > view.end || (r.started < view.start && r.ended === null)) return [];
      if (until - r.started < LONG_MS) return [{ r, until, row: 2 }];
      const free = rows.findIndex(last => last < r.started), row = free < 0 ? 1 : free;
      rows[row] = until;
      return [{ r, until, row }];
    });
  }, [programs, view.start, view.end]);

  const rs = summarizeResponse(frames, interactions, response.spans, view.start, view.end);
  const index = at === null ? -1 : nearest(points, from, to, at), pick = index >= 0 && Math.abs(points[index].time - at!) <= GAP_MS / 2 ? points[index] : null;
  const near = (time: number) => Math.abs(x(time) - x(pick?.time ?? at ?? 0)) <= 6;
  const frame = at === null ? undefined : (() => { const i = nearest(frames, fFrom, fTo, at); return i >= 0 && near(frames[i].time) ? frames[i] : undefined; })();
  const interaction = at === null ? undefined : (() => { const i = nearest(interactions, iFrom, iTo, at); return i >= 0 && near(interactions[i].time) ? interactions[i] : undefined; })();
  const cursor = pick ? x(pick.time) : at !== null && (frame || interaction) ? x(at) : null;
  const live = !held && !stale && geometry.cpu.last && end - geometry.cpu.last.time < GAP_MS;
  const peek = (time: number | null) => { if (time === null) { setHeld(null); setAt(null); } else { setHeld(current => current ?? { start, end }); setAt(time); } };
  const values = (field: 'cpu' | 'memory', g: number) => { const v = pick?.[field]; return v ? (field === 'cpu' ? cpu(v[g]) : bytes(v[g])) : '—'; };
  const total = (field: 'cpu' | 'memory') => { const v = pick?.[field]; return v ? (field === 'cpu' ? cpu(sum(v)) : bytes(sum(v))) : '—'; };
  // Under the Host: who ran on its main thread at that moment (its other threads, such as file and network work, are not split).
  const owners = pick?.owners ? Object.entries(pick.owners).filter(([, v]) => v >= OWNER_SHOWN).sort((a, b) => b[1] - a[1]).slice(0, 2) : [];
  const system = sample?.system, supported = response.supported.frames || response.supported.interactions;

  // Every track's head reads the same way: what it is, its value, and one line to judge that value by. A peak or a change reads
  // off the chart beside it, so it is not written here again; the machine's memory in GB shows on pointing at its line.
  const heads: { key: string; box: { top: number; height: number }; label: string; tip: string; value: string; tone?: 'warn'; line: string | null; detail?: string }[] = [
    { key: 'cpu', box: TRACK.cpu, label: 'CPU', value: cpu(sample?.cpu), line: system ? `整机 ${cpu(system.cpu)}` : null,
      tip: 'DSH 和它启动的程序占整台电脑算力的比例，所有核心满载为 100%，和任务管理器一致。「整机」是整台电脑此刻的占用，包括其他程序。' },
    { key: 'memory', box: TRACK.memory, label: '内存', value: bytes(sample?.memory),
      line: system ? `整机 ${Math.round(system.memoryUsed / system.memoryTotal * 100)}%` : null, detail: system ? `整机已用 ${gb(system.memoryUsed)} / ${gb(system.memoryTotal)}` : undefined,
      tip: 'DSH 和它启动的程序独占的物理内存，对应任务管理器「详细信息」里的「内存(专用工作集)」。「整机」是整台电脑已用内存的比例。' },
    { key: 'response', box: TRACK.response, label: '界面响应', value: !supported || !rs.observedMs ? '—' : rs.frames ? `${rs.frames} 次卡顿` : '流畅', tone: rs.frames >= 3 ? 'warn' : undefined,
      line: !supported ? '当前环境不支持监测' : rs.longestFrame !== null ? `最长 ${duration(rs.longestFrame)}` : rs.observedMs ? `近 ${span(rs.observedMs)}没有卡顿` : '窗口可见时开始记录',
      tip: `卡顿：DSH 窗口有一帧被拖住超过 50 毫秒，期间画面停住、点了没反应。图上的圆点是操作响应：从点击或按键到画面给出反馈的时间，超过 ${SLOW_INTERACTION_MS} 毫秒标红。只在窗口可见时记录，打开本页期间本页自身的绘制也计入。` },
  ];
  const g = geometry, rp = plot(TRACK.response);
  // Past the slow-interaction line the scale marks that line, dashed, rather than the half way.
  const slowLine = g.response.max > SLOW_INTERACTION_MS, msScale = slowLine ? [SLOW_INTERACTION_MS, g.response.max] : [g.response.max / 2, g.response.max];
  const label = pick ? `${clock(pick.time)}，DSH CPU ${total('cpu')}，内存 ${total('memory')}` : '最新读数';

  return <section className="dpm-card dpm-timeline" aria-label="趋势" data-stale={stale || undefined}>
    <div className="dpm-tl">
      {[TRACK.memory.top, TRACK.response.top, TRACK.lane.top].map(top => <i key={top} className="dpm-tl-rule" style={{ top }} />)}
      <div className="dpm-heads" style={{ height: H }}>
        {heads.map(h => <div key={h.key} className="dpm-head" style={{ top: h.box.top, height: h.box.height }}>
          <span className="dpm-head-label">{h.label}<Tip text={h.tip} label={`${h.label}是怎么算的`} /></span>
          <strong className="dpm-head-value" data-tone={h.tone}><Figure text={h.value} /></strong>
          {h.line && <span className="dpm-head-line" title={h.detail}>{h.line}</span>}
        </div>)}
        <div className="dpm-head dpm-head-lane" style={{ top: TRACK.lane.top, height: TRACK.lane.height }}>程序启停</div>
      </div>
      <div ref={canvas} className="dpm-canvas" tabIndex={0} role="slider" aria-label="趋势：左右方向键逐点查看，Esc 退出"
        aria-valuemin={0} aria-valuemax={Math.max(0, to - from - 1)} aria-valuenow={pick ? index - from : 0} aria-valuetext={label}
        onPointerMove={event => { setHeld(current => current ?? { start, end }); setAt(view.start + (event.clientX - event.currentTarget.getBoundingClientRect().left - X) / plotWidth * spanMs); }}
        onPointerLeave={() => peek(null)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) peek(null); }}
        onKeyDown={event => {
          if (to <= from) return;
          const i = pick ? index : to;
          const next = event.key === 'Home' ? from : event.key === 'End' ? to - 1 : event.key === 'ArrowLeft' ? i - 1 : event.key === 'ArrowRight' ? i + 1 : null;
          if (next === null) { if (event.key === 'Escape') peek(null); return; }
          event.preventDefault(); peek(points[Math.max(from, Math.min(to - 1, next))].time);
        }}>
        {width > 0 && <svg width={width} height={H} aria-hidden="true">
          <defs><clipPath id="dpm-trend-clip"><rect x={X} y={0} width={plotWidth} height={H} /></clipPath></defs>
          {(['cpu', 'memory'] as const).map(field => {
            const t = g[field], p = plot(TRACK[field]);
            return <g key={field}>
              <g className="dpm-grid">{[.5, 1].map(n => <line key={n} x1={X} x2={X + plotWidth} y1={t.y(t.max * n)} y2={t.y(t.max * n)} />)}</g>
              <line className="dpm-base" x1={X} x2={X + plotWidth} y1={p.bottom + .5} y2={p.bottom + .5} />
              <g clipPath="url(#dpm-trend-clip)">
                {t.areas.map((d, i) => d && <path key={GROUPS[i]} className="dpm-area" data-group={GROUPS[i]} d={d} />)}
                {t.lines.map((d, i) => d && <path key={GROUPS[i]} className="dpm-band" data-group={GROUPS[i]} d={d} />)}
                {live && t.last && <g key={t.last.time} className="dpm-now"><circle cx={t.last.x} cy={t.last.y} r={6} /><circle cx={t.last.x} cy={t.last.y} r={2.75} /></g>}
                {pick && pick[field] && <circle className="dpm-marker" cx={x(pick.time)} cy={t.y(sum(pick[field]!))} r={3.5} />}
              </g>
              {/* The scale sits over the data, haloed, so a line running through it does not hide it. */}
              <g className="dpm-grid">{[.5, 1].map(n => <text key={n} x={X + plotWidth} y={t.y(t.max * n) - 4} textAnchor="end">
                {field === 'cpu' ? `${+(t.max * n).toFixed(1)}%` : axisBytes(t.max * n)}</text>)}</g>
              {!t.last && field === 'cpu' && <text className="dpm-empty" x={X + plotWidth / 2} y={(p.top + p.bottom) / 2}>{points.length ? '第二次读数后开始绘制' : '正在收集数据…'}</text>}
            </g>;
          })}
          <g className="dpm-grid">{(slowLine ? [g.response.max] : msScale).map(v => <line key={v} x1={X} x2={X + plotWidth} y1={g.response.y(v)} y2={g.response.y(v)} />)}</g>
          {slowLine && <line className="dpm-threshold" x1={X} x2={X + plotWidth} y1={g.response.y(SLOW_INTERACTION_MS)} y2={g.response.y(SLOW_INTERACTION_MS)} />}
          <line className="dpm-base" x1={X} x2={X + plotWidth} y1={rp.bottom + .5} y2={rp.bottom + .5} />
          <g clipPath="url(#dpm-trend-clip)">
            {/* When the window was being watched: a quiet stretch with this line is calm, one without it was not seen. */}
            {response.spans.map(w => <rect key={w.start} className="dpm-watch" x={x(Math.max(view.start, w.start))} y={rp.bottom + 2} height={2}
              width={Math.max(0, x(Math.min(view.end, w.end)) - x(Math.max(view.start, w.start)))} />)}
            {frames.slice(fFrom, fTo).map((f: Frame) => <rect key={f.time} className="dpm-frame" data-long={f.duration >= 1000 || undefined} data-picked={f === frame || undefined}
              x={x(f.time) - 1.5} width={3} rx={1} y={g.response.y(f.duration)} height={Math.max(1, rp.bottom - g.response.y(f.duration))} />)}
            {interactions.slice(iFrom, iTo).map((i: Interaction) => <circle key={i.id} className="dpm-tap" data-slow={i.duration >= SLOW_INTERACTION_MS || undefined}
              data-picked={i === interaction || undefined} cx={x(i.time)} cy={g.response.y(i.duration)} r={i.duration >= SLOW_INTERACTION_MS ? 3.25 : 2.25} />)}
          </g>
          <g className="dpm-grid">{msScale.map(v => <text key={v} x={X + plotWidth} y={g.response.y(v) - 4} textAnchor="end">{axisMs(v)}</text>)}</g>
          {!lanes.length && <text className="dpm-lane-empty" x={X + 4} y={TRACK.lane.top + 31}>这段时间没有程序启动或退出</text>}
          {timeTicks(view.start, view.end).filter(t => x(t) >= X + 18 && x(t) <= X + plotWidth - 18).map(t =>
            <text key={t} className="dpm-tick" x={x(t)} y={H - 6} textAnchor="middle">{clockShort(t)}</text>)}
          {cursor !== null && <line className="dpm-cursor" x1={cursor} x2={cursor} y1={4} y2={TRACK.lane.top + TRACK.lane.height - 4} />}
        </svg>}
        {width > 0 && lanes.map(({ r, row, until }) => {
          const left = x(Math.max(view.start, r.started)), right = x(Math.min(view.end, until)), name = programTitle(r.name, r.summary);
          const title = `${name}：${clock(r.started)} 启动${r.ended === null ? '，仍在运行' : `，${clock(r.ended)} 退出，运行 ${span(r.ended - r.started)}`}`;
          const open = (event: React.MouseEvent) => { event.stopPropagation(); onOpen(r.key); };
          // Reached by pointer here; by keyboard, every program is in the list below.
          return row < 2
            ? <button key={r.key} type="button" tabIndex={-1} className="dpm-life" data-running={r.ended === null || undefined} title={title} aria-label={title}
              style={{ left, width: Math.max(6, right - left), top: TRACK.lane.top + 5 + row * 19 }} onClick={open}>{right - left > 72 && <span>{name}</span>}</button>
            : <button key={r.key} type="button" tabIndex={-1} className="dpm-blip" title={title} aria-label={title} style={{ left: left - 1.5, top: TRACK.lane.top + 42 }} onClick={open} />;
        })}
        {cursor !== null && <div className="dpm-tooltip" data-flip={cursor > width * .62 || undefined} style={{ left: cursor }}>
          <time>{clock(pick?.time ?? at!)}</time>
          {pick && <table>
            <thead><tr><th /><th>CPU</th><th>内存</th></tr></thead>
            <tbody>{[...GROUPS].reverse().map(group => { const i = GROUPS.indexOf(group); return <React.Fragment key={group}>
              <tr data-group={group}><th><i />{GROUP_LABEL[group]}</th><td>{values('cpu', i)}</td><td>{values('memory', i)}</td></tr>
              {group === 'host' && owners.map(([owner, v]) => <tr key={owner} className="dpm-tooltip-sub"><th>其中 {ownerName(owner)}</th><td>{cpu(v)}</td><td /></tr>)}
            </React.Fragment>; })}</tbody>
            <tfoot>
              <tr><th>DSH 合计</th><td>{total('cpu')}</td><td>{total('memory')}</td></tr>
              {(pick.systemCpu !== null || pick.systemMemory !== null) && <tr className="dpm-tooltip-machine"><th>整机</th><td>{cpu(pick.systemCpu)}</td><td>{pick.systemMemory === null ? '—' : gb(pick.systemMemory)}</td></tr>}
            </tfoot>
          </table>}
          {(frame || interaction) && <p>{frame && <span>卡顿 <b>{duration(frame.duration)}</b></span>}{interaction && <span>{interaction.kind === 'key' ? '按键' : '点击'}响应 <b>{duration(interaction.duration)}</b></span>}</p>}
        </div>}
      </div>
    </div>
    <div className="dpm-legend" aria-label="图例">
      {GROUPS.map(group => <button key={group} type="button" className="dpm-key" data-group={group} title={`查看${GROUP_LABEL[group]}`}
        onPointerEnter={() => onFocus(group)} onPointerLeave={() => onFocus(null)} onFocus={() => onFocus(group)} onBlur={() => onFocus(null)}
        onClick={() => onOpen(groupKey(group))}><i />{GROUP_LABEL[group]}</button>)}
      <span className="dpm-legend-sep" aria-hidden="true" />
      <span className="dpm-mark" data-mark="frame"><i />卡顿</span>
      <span className="dpm-mark" data-mark="tap"><i />操作响应</span>
      <span className="dpm-mark" data-mark="slow"><i />{`慢于 ${SLOW_INTERACTION_MS} 毫秒`}</span>
    </div>
  </section>;
});
