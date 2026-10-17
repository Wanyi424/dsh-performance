import React, { memo } from 'react';
import { GROUPS, type Group, type Sample } from './contracts';
import { bytes, cpu } from './format';
import { keyOf, pointOf, programName, programs, sum } from './insights';
import { GROUP_LABEL, KIND } from './labels';

const GB = 1024 ** 3;
const pct = (value: number) => `${Math.max(0, Math.min(100, value))}%`;
/** One machine resource as a bar: DSH's part in its five colours, then other programs, then what is free. */
function Share({ label, value, parts, other, legend, onFocus }: {
  label: string; value: string; parts: number[]; other: number; legend: React.ReactNode; onFocus(group: Group | null): void;
}) {
  return <div className="dpm-share-row">
    <span className="dpm-share-label">{label}</span>
    <strong className="dpm-share-value">{value}</strong>
    <span className="dpm-share-bar" role="img" aria-label={`${label} ${value}`}>
      {/* Segments too thin to see are left out, so they do not leave stray gaps. */}
      {parts.map((part, i) => part >= .15 && <i key={GROUPS[i]} className="dpm-seg" data-group={GROUPS[i]} style={{ width: pct(part) }}
        title={GROUP_LABEL[GROUPS[i]]} onPointerEnter={() => onFocus(GROUPS[i])} onPointerLeave={() => onFocus(null)} />)}
      {other >= .15 && <i className="dpm-seg dpm-seg-other" style={{ width: pct(other) }} title="其他程序" />}
    </span>
    <span className="dpm-share-legend">{legend}</span>
  </div>;
}

export const Now = memo(function Now({ sample, onFocus, onOpen }: { sample?: Sample; onFocus(group: Group | null): void; onOpen(key: string): void }) {
  if (!sample) return <section className="dpm-now" aria-label="此刻" aria-busy="true"><div className="dpm-now-skeleton" /><div className="dpm-now-skeleton" /></section>;
  const point = pointOf(sample), system = sample.system, total = system?.memoryTotal ?? 0;
  const dshCpu = point.cpu ? sum(point.cpu) : null, dshMemory = point.memory ? sum(point.memory) : null;
  const otherCpu = system?.cpu != null && dshCpu !== null ? Math.max(0, system.cpu - dshCpu) : 0;
  const otherMemory = system && dshMemory !== null ? Math.max(0, system.memoryUsed - dshMemory) : 0;
  // The biggest single consumers right now: a DSH process or a whole tool program.
  const rows = [...sample.processes.filter(p => p.kind !== 'tool').map(p => ({ key: keyOf(p), name: KIND[p.kind].label, cpu: p.cpu, memory: p.memory })),
    ...programs(sample.processes).map(p => ({ key: p.key, name: programName(p.lead.name), cpu: p.cpu, memory: p.memory }))];
  const top = (field: 'cpu' | 'memory') => rows.reduce<typeof rows[number] | undefined>((best, r) => (r[field] ?? -1) > (best?.[field] ?? -1) ? r : best, undefined);
  const busiest = top('cpu'), largest = top('memory');
  return <section className="dpm-now" aria-label="此刻">
    <Share label="整机 CPU" value={cpu(system?.cpu)} onFocus={onFocus}
      parts={point.cpu ?? GROUPS.map(() => 0)} other={otherCpu}
      legend={<><b>DSH {cpu(dshCpu)}</b><span>其他程序 {system?.cpu == null ? '—' : cpu(otherCpu)}</span></>} />
    <Share label="整机内存" value={system ? `${(system.memoryUsed / GB).toFixed(1)} / ${(total / GB).toFixed(1)} GB` : '—'} onFocus={onFocus}
      parts={point.memory && total ? point.memory.map(v => v / total * 100) : GROUPS.map(() => 0)} other={total ? otherMemory / total * 100 : 0}
      legend={<><b>DSH {bytes(dshMemory)}</b><span>其他程序 {system ? bytes(otherMemory) : '—'}</span><span>可用 {system ? bytes(total - system.memoryUsed) : '—'}</span></>} />
    <p className="dpm-now-top">
      {busiest?.cpu != null && <span>CPU 最高<button type="button" className="dpm-link" onClick={() => onOpen(busiest.key)}>{busiest.name}</button>{cpu(busiest.cpu)}</span>}
      {largest?.memory != null && <span>内存最多<button type="button" className="dpm-link" onClick={() => onOpen(largest.key)}>{largest.name}</button>{bytes(largest.memory)}</span>}
      {!!sample.unavailable && <span data-tone="warn">{sample.unavailable} 个进程没有读取权限，未计入</span>}
    </p>
  </section>;
});
