import React, { memo } from 'react';
import { firstTime } from './insights';
import type { Series } from './tracking';

const MB = 1024 ** 2;
/** `min`/`max` bound the drawing; `peak` is the highest reading itself. */
export interface Trend { line: string; area: string; min: number; max: number; peak: number; last: { x: number; y: number } | null }
/**
 * The part of a series inside [start, end] as a line and the area under it. CPU is drawn from zero; memory from just below
 * its lowest reading, so growth shows, but over at least `floor` (32 MB for a process), so noise does not pass for growth.
 */
export function trend(series: Series | undefined, field: 'cpu' | 'memory', start: number, end: number, width: number, height: number, pad = 2, floor = 32 * MB): Trend {
  const empty = { line: '', area: '', min: 0, max: 0, peak: 0, last: null };
  if (!series) return empty;
  const from = Math.max(0, firstTime(series.times, start) - 1), values = series[field];
  let lo = Infinity, hi = -Infinity;
  for (let i = from; i < values.length; i++) if (!Number.isNaN(values[i])) { lo = Math.min(lo, values[i]); hi = Math.max(hi, values[i]); }
  if (hi === -Infinity) return empty;
  const min = field === 'cpu' ? 0 : Math.max(0, Math.min(lo, hi - floor) - (hi - lo) * .15);
  const max = field === 'cpu' ? Math.max(hi * 1.15, 1) : Math.max(hi, min + floor);
  const x = (t: number) => (t - start) / (end - start) * width, y = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / (max - min));
  let line = '', area = '', run: string[] = [], runStart = 0, last: Trend['last'] = null;
  const close = (xEnd: number) => { if (run.length > 1) { line += `M${run.join('L')}`; area += `M${runStart.toFixed(1)},${height}L${run.join('L')}L${xEnd.toFixed(1)},${height}Z`; } run = []; };
  let previous = NaN;
  for (let i = from; i < values.length; i++) {
    const v = values[i], px = Math.max(0, x(series.times[i]));
    if (Number.isNaN(v)) { close(x(series.times[previous] ?? 0)); continue; }
    if (!run.length) runStart = px;
    run.push(`${px.toFixed(1)},${y(v).toFixed(1)}`); previous = i; last = { x: px, y: y(v) };
  }
  if (!Number.isNaN(previous)) close(x(series.times[previous]));
  return { line, area, min, max, peak: hi, last };
}

export const Sparkline = memo(function Sparkline({ series, field, start, end, group, floor, width = 88, height = 26 }: {
  series?: Series; field: 'cpu' | 'memory'; start: number; end: number; group: string; floor?: number; width?: number; height?: number;
}) {
  const t = trend(series, field, start, end, width, height, 2, floor);
  // Drawn on a fixed grid and stretched to the column, so a narrow table only squeezes it; the stroke keeps its width.
  return <svg className="dpm-spark" data-group={group} width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    {t.area && <path className="dpm-spark-area" d={t.area} />}
    {t.line && <path className="dpm-spark-line" d={t.line} />}
  </svg>;
});
