import React, { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GROUPS, type Group, type Point } from './contracts';
import { bytes, change, clock, clockShort, cpu, ms, span as duration } from './format';
import { GAP_MS, SLOW_INTERACTION_MS, decimate, firstAt, sum, summarize, summarizeResponse } from './insights';
import { GROUP_LABEL } from './labels';
import type { Frame, Interaction, ResponseLog } from './responsiveness';
import type { ProgramRecord } from './tracking';

/** Vertical layout of the shared canvas: three tracks, the program lane and the time axis. */
const CPU = { top: 0, height: 128 }, MEMORY = { top: 128, height: 128 }, RESPONSE = { top: 256, height: 104 };
const LANE = { top: 360, height: 26 }, H = 408, X = 12;
const MB = 1024 ** 2, GB = 1024 ** 3;
const CPU_STEPS = [2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];
/** Programs that ran at least this long draw as lifetime bars; shorter ones, such as single commands, as ticks below them. */
const LONG_MS = 60_000;
const MEMORY_STEPS = [.25, .5, .75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64].map(n => n * GB);
const MS_STEPS = [100, 200, 300, 500, 1000, 2000, 5000, 10_000, 30_000];
const MINUTE_STEPS = [1, 2, 5, 10, 15, 30].map(n => n * 60_000);
const ceilTo = (steps: number[], value: number) => steps.find(step => step >= value) ?? steps.at(-1)!;
const axisBytes = (value: number) => value >= GB ? `${+(value / GB).toFixed(2)} GB` : `${Math.round(value / MB)} MB`;
const plot = (track: { top: number; height: number }) => ({ top: track.top + 18, bottom: track.top + track.height - 10 });

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
function latest(points: Point[], field: 'cpu' | 'memory') {
  for (let i = points.length - 1; i >= 0; i--) if (points[i][field]) return points[i];
}

/** A clock time in a track header: pointing at it moves the crosshair to that moment. */
function Moment({ time, onPeek }: { time: number | null; onPeek(time: number | null): void }) {
  if (time === null) return null;
  return <button type="button" className="dpm-moment" onPointerEnter={() => onPeek(time)} onPointerLeave={() => onPeek(null)}
    onFocus={() => onPeek(time)} onBlur={() => onPeek(null)} aria-label={`查看 ${clock(time)}`}>{clockShort(time)}</button>;
}
function Figure({ text }: { text: string }) {
  const parts = /^([<\d.,]+)\s*(.*)$/.exec(text);
  return parts ? <>{parts[1]}{parts[2] && <small>{parts[2]}</small>}</> : <>{text}</>;
}

export const Timeline = memo(function Timeline({ points, response, programs, start, end, onFocus }: {
  points: Point[]; response: ResponseLog; programs: readonly ProgramRecord[]; start: number; end: number; onFocus(group: Group | null): void;
}) {
  const canvas = useRef<HTMLDivElement>(null), id = useId(), [width, setWidth] = useState(0);
  // While a moment is inspected, the window holds still, so the inspected moment does not slide away.
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
    const max = ceilTo(MS_STEPS, peak * 1.15), p = plot(RESPONSE);
    return { cpu: track('cpu', CPU), memory: track('memory', MEMORY), response: { max, y: (v: number) => p.bottom - Math.min(v, max) / max * (p.bottom - p.top) } };
  }, [points, frames, interactions, from, to, fFrom, fTo, iFrom, iTo, view.start, spanMs, plotWidth]);

  const summary = summarize(points, view.start, view.end), rs = summarizeResponse(frames, interactions, response.spans, view.start, view.end);
  const nowCpu = latest(points, 'cpu'), nowMemory = latest(points, 'memory');
  const index = at === null ? -1 : nearest(points, from, to, at), pick = index >= 0 && Math.abs(points[index].time - at!) <= GAP_MS / 2 ? points[index] : null;
  const near = (time: number) => Math.abs(x(time) - x(pick?.time ?? at ?? 0)) <= 6;
  const frame = at === null ? undefined : (() => { const i = nearest(frames, fFrom, fTo, at); return i >= 0 && near(frames[i].time) ? frames[i] : undefined; })();
  const interaction = at === null ? undefined : (() => { const i = nearest(interactions, iFrom, iTo, at); return i >= 0 && near(interactions[i].time) ? interactions[i] : undefined; })();
  const cursor = pick ? x(pick.time) : at !== null && (frame || interaction) ? x(at) : null;
  const live = !held && nowCpu && end - nowCpu.time < GAP_MS;
  // The lane shows what started or stopped in view; a program running through the whole window has nothing to mark. Long runs
  // pack onto two rows of lifetime bars, single commands become ticks below them.
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
  const peek = (time: number | null) => { if (time === null) { setHeld(null); setAt(null); return; } setHeld(current => current ?? { start, end }); setAt(time); };
  const values = (field: 'cpu' | 'memory', g: number) => { const v = pick?.[field]; return v ? (field === 'cpu' ? cpu(v[g]) : bytes(v[g])) : '—'; };
  const total = (field: 'cpu' | 'memory') => { const v = pick?.[field]; return v ? (field === 'cpu' ? cpu(sum(v)) : bytes(sum(v))) : '—'; };
  const respond = rs.observedMs ? rs.frames ? `${rs.frames} 次卡顿` : '流畅' : '—';
  const label = pick ? `${clock(pick.time)}，CPU ${total('cpu')}，内存 ${total('memory')}` : '最新读数';

  const tracks: { key: string; box: { top: number; height: number }; label: string; value: string; lines: React.ReactNode[] }[] = [
    { key: 'cpu', box: CPU, label: 'CPU', value: cpu(nowCpu && sum(nowCpu.cpu!)), lines: [
      summary.averageCpu === null ? '第二次读数后显示' : `平均 ${cpu(summary.averageCpu)}`,
      summary.peakCpu === null ? null : <>峰值 {cpu(summary.peakCpu)}<Moment time={summary.peakCpuAt} onPeek={peek} /></>] },
    { key: 'memory', box: MEMORY, label: '内存', value: bytes(nowMemory && sum(nowMemory.memory!)), lines: [
      summary.peakMemory === null ? '—' : <>峰值 {bytes(summary.peakMemory)}<Moment time={summary.peakMemoryAt} onPeek={peek} /></>,
      summary.memoryChange === null ? null : `较 ${duration(view.end - summary.since!)}前 ${change(summary.memoryChange)}`] },
    { key: 'response', box: RESPONSE, label: '界面响应', value: response.supported.frames || response.supported.interactions ? respond : '—', lines: [
      !response.supported.frames && !response.supported.interactions ? '当前环境不支持监测' : rs.longestFrame === null ? (rs.observedMs ? `近 ${duration(rs.observedMs)}没有卡顿` : '窗口可见时开始记录')
        : <>最长 {ms(rs.longestFrame)}<Moment time={rs.longestFrameAt} onPeek={peek} /></>,
      rs.slowest === null ? null : <>最慢交互 {ms(rs.slowest)}{rs.slow ? `，${rs.slow} 次偏慢` : ''}</>] },
  ];

  return <section className="dpm-timeline" aria-label="趋势">
    <header className="dpm-timeline-head">
      <h2>趋势</h2>
      <ul className="dpm-keys" aria-label="图例">
        {GROUPS.map(g => <li key={g} data-group={g} onPointerEnter={() => onFocus(g)} onPointerLeave={() => onFocus(null)}><i />{GROUP_LABEL[g]}</li>)}
        <li className="dpm-key-frame"><i />卡顿</li>
        <li className="dpm-key-tap"><i />交互</li>
        <li className="dpm-key-slow"><i />{`交互超过 ${SLOW_INTERACTION_MS} ms`}</li>
      </ul>
    </header>
    <div className="dpm-timeline-body" data-inspecting={pick ? '' : undefined}>
      <div className="dpm-track-heads" style={{ height: H }}>
        {tracks.map(t => <div key={t.key} className="dpm-track-head" style={{ top: t.box.top, height: t.box.height }}>
          <span className="dpm-track-label">{t.label}</span>
          <strong className="dpm-track-value"><Figure text={t.value} /></strong>
          {t.lines.map((line, i) => line && <span key={i} className="dpm-track-line">{line}</span>)}
        </div>)}
        <div className="dpm-track-head dpm-lane-head" style={{ top: LANE.top, height: LANE.height }}><span className="dpm-track-label">工具进程</span></div>
      </div>
      <div ref={canvas} className="dpm-canvas" tabIndex={0} role="slider" aria-label="趋势，左右方向键逐点查看，Esc 退出"
        aria-valuemin={0} aria-valuemax={Math.max(0, to - from - 1)} aria-valuenow={pick ? index - from : 0} aria-valuetext={label}
        onPointerMove={event => {
          const time = view.start + (event.clientX - event.currentTarget.getBoundingClientRect().left - X) / plotWidth * spanMs;
          setHeld(current => current ?? { start, end }); setAt(time);
        }}
        onPointerLeave={() => peek(null)} onBlur={() => peek(null)}
        onKeyDown={event => {
          if (to <= from) return;
          const i = pick ? index : to;
          const next = event.key === 'Home' ? from : event.key === 'End' ? to - 1 : event.key === 'ArrowLeft' ? i - 1 : event.key === 'ArrowRight' ? i + 1 : null;
          if (next === null) { if (event.key === 'Escape') peek(null); return; }
          event.preventDefault(); peek(points[Math.max(from, Math.min(to - 1, next))].time);
        }}>
        {width > 0 && <svg width={width} height={H} aria-hidden="true">
          <defs>
            <clipPath id={`${id}-clip`}><rect x={X} y={0} width={plotWidth} height={H} /></clipPath>
          </defs>
          {[MEMORY, RESPONSE, LANE].map(box => <line key={box.top} className="dpm-divider" x1={0} x2={width} y1={box.top + .5} y2={box.top + .5} />)}
          {([['cpu', CPU], ['memory', MEMORY]] as const).map(([field, box], k) => {
            const g = geometry[field], p = plot(box);
            return <g key={field}>
              {[.5, 1].map(n => <g key={n} className="dpm-grid">
                <line x1={X} x2={X + plotWidth} y1={g.y(g.max * n)} y2={g.y(g.max * n)} />
                <text x={X + plotWidth} y={g.y(g.max * n) - 4} textAnchor="end">{field === 'cpu' ? `${g.max * n}%` : axisBytes(g.max * n)}</text>
              </g>)}
              <line className="dpm-baseline" x1={X} x2={X + plotWidth} y1={p.bottom + .5} y2={p.bottom + .5} />
              <g clipPath={`url(#${id}-clip)`}>
                {g.areas.map((d, i) => d && <path key={GROUPS[i]} className="dpm-area" data-group={GROUPS[i]} d={d} />)}
                {g.lines.map((d, i) => ({ d, i })).reverse().map(({ d, i }) => d && <path key={GROUPS[i]} className="dpm-band" data-group={GROUPS[i]} d={d} />)}
                {live && g.last && <g key={g.last.time} className="dpm-live"><circle className="dpm-live-ring" cx={g.last.x} cy={g.last.y} r={6} /><circle cx={g.last.x} cy={g.last.y} r={2.75} /></g>}
                {pick && pick[field] && <circle className="dpm-marker" cx={x(pick.time)} cy={g.y(sum(pick[field]!))} r={3.5} />}
              </g>
              {!g.last && k === 0 && <text className="dpm-empty" x={X + plotWidth / 2} y={(p.top + p.bottom) / 2}>{points.length ? '第二次读数后开始绘制' : '正在收集数据…'}</text>}
            </g>;
          })}
          <g>
            {(() => { const g = geometry.response, p = plot(RESPONSE); return <>
              {[.5, 1].map(n => <g key={n} className="dpm-grid"><line x1={X} x2={X + plotWidth} y1={g.y(g.max * n)} y2={g.y(g.max * n)} />
                <text x={X + plotWidth} y={g.y(g.max * n) - 4} textAnchor="end">{ms(g.max * n)}</text></g>)}
              {g.max > SLOW_INTERACTION_MS && <line className="dpm-threshold" x1={X} x2={X + plotWidth} y1={g.y(SLOW_INTERACTION_MS)} y2={g.y(SLOW_INTERACTION_MS)} />}
              <line className="dpm-baseline" x1={X} x2={X + plotWidth} y1={p.bottom + .5} y2={p.bottom + .5} />
              <g clipPath={`url(#${id}-clip)`}>
                {response.spans.map(s => <rect key={s.start} className="dpm-watch" x={x(Math.max(view.start, s.start))} y={p.bottom + 2} height={2}
                  width={Math.max(0, x(Math.min(view.end, s.end)) - x(Math.max(view.start, s.start)))} />)}
                {frames.slice(fFrom, fTo).map((f: Frame) => <rect key={f.time} className="dpm-frame" data-picked={f === frame || undefined} x={x(f.time) - 1.5} width={3} rx={1}
                  y={g.y(f.duration)} height={Math.max(1, p.bottom - g.y(f.duration))} />)}
                {interactions.slice(iFrom, iTo).map((i: Interaction) => <circle key={i.id} className="dpm-interaction" data-slow={i.duration >= SLOW_INTERACTION_MS || undefined}
                  data-picked={i === interaction || undefined} cx={x(i.time)} cy={g.y(i.duration)} r={i.duration >= SLOW_INTERACTION_MS ? 3.25 : 2.25} />)}
              </g>
            </>; })()}
          </g>
          <g clipPath={`url(#${id}-clip)`}>
            {lanes.map(({ r, row, until }) => {
              const title = `${r.name}${r.summary ? ` ${r.summary}` : ''}\n${clock(r.started)} 启动${r.ended === null ? '，仍在运行' : `，${clock(r.ended)} 退出，运行 ${duration(r.ended - r.started)}`}`;
              return row < 2
                ? <rect key={r.key} className="dpm-life" data-running={r.ended === null || undefined} x={x(Math.max(view.start, r.started))} y={LANE.top + 3 + row * 7} rx={2.5} height={5}
                  width={Math.max(3, x(until) - x(Math.max(view.start, r.started)))}><title>{title}</title></rect>
                : <rect key={r.key} className="dpm-blip" x={x(r.started) - 1} y={LANE.top + 17} rx={1} width={2} height={7}><title>{title}</title></rect>;
            })}
          </g>
          {timeTicks(view.start, view.end).filter(t => x(t) >= X + 18 && x(t) <= X + plotWidth - 18).map(t =>
            <text key={t} className="dpm-tick" x={x(t)} y={H - 6} textAnchor="middle">{clockShort(t)}</text>)}
          {cursor !== null && <line className="dpm-cursor" x1={cursor} x2={cursor} y1={4} y2={LANE.top + LANE.height} />}
        </svg>}
        {cursor !== null && <div className="dpm-tip" data-flip={cursor > width * .62 || undefined} style={{ left: cursor }}>
          <time>{clock(pick?.time ?? at!)}</time>
          {pick && <table>
            <thead><tr><th /><th>CPU</th><th>内存</th></tr></thead>
            <tbody>{[...GROUPS].reverse().map(g => { const i = GROUPS.indexOf(g); return <tr key={g} data-group={g}><th><i />{GROUP_LABEL[g]}</th><td>{values('cpu', i)}</td><td>{values('memory', i)}</td></tr>; })}</tbody>
            <tfoot>
              <tr><th>DSH 合计</th><td>{total('cpu')}</td><td>{total('memory')}</td></tr>
              {(pick.systemCpu !== null || pick.systemMemory !== null) && <tr className="dpm-tip-machine"><th>整机</th><td>{cpu(pick.systemCpu)}</td><td>{bytes(pick.systemMemory)}</td></tr>}
            </tfoot>
          </table>}
          {(frame || interaction) && <p>{frame && <span>卡顿 <b>{ms(frame.duration)}</b></span>}{interaction && <span>{interaction.kind === 'key' ? '按键' : '点击'}响应 <b>{ms(interaction.duration)}</b></span>}</p>}
        </div>}
      </div>
    </div>
  </section>;
});
