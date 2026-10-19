import React, { useId, useRef, useState } from 'react';
import { Info } from './icons';

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange(value: T): void; label: string;
}) {
  const index = Math.max(0, options.findIndex(option => option.value === value));
  return <div className="dpm-segmented" role="group" aria-label={label} style={{ '--count': options.length, '--index': index } as React.CSSProperties}>
    <span className="dpm-segmented-thumb" aria-hidden />
    {options.map(option => <button key={option.value} type="button" aria-pressed={option.value === value}
      onClick={() => { if (option.value !== value) onChange(option.value); }}>{option.label}</button>)}
  </div>;
}

/** A term explained where it appears: the mark shows a short note on hover or keyboard focus, and reads it to a screen reader. */
export function Tip({ text, label, align = 'start' }: { text: string; label: string; align?: 'start' | 'end' }) {
  const id = useId();
  return <span className="dpm-tip" data-align={align}>
    <button type="button" className="dpm-tip-mark" aria-label={label} aria-describedby={id}><Info size={13} /></button>
    <span role="tooltip" id={id}>{text}</span>
  </span>;
}

/** A big number with its unit set smaller: `1.02` `GB`, `2.1` `%`. */
export function Figure({ text }: { text: string }) {
  const parts = /^([<\d.,±+−-]+)\s*(.*)$/.exec(text);
  return parts ? <>{parts[1]}{parts[2] && <small>{parts[2]}</small>}</> : <>{text}</>;
}

/**
 * Rows follow the chosen order on every reading, except while the pointer rests on the list: then they hold their places, so
 * the row about to be clicked does not move away. New rows join at the end until the pointer leaves.
 */
export function useSteadyOrder(keys: string[], held: boolean) {
  const order = useRef<string[]>([]);
  if (!held) order.current = keys;
  else { const present = new Set(keys); order.current = [...order.current.filter(k => present.has(k)), ...keys.filter(k => !order.current.includes(k))]; }
  return order.current;
}

/** A per-viewer preference, such as the chosen range; storage can be unavailable, and then the default simply applies. */
export function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try { const stored = localStorage.getItem(`dsh-performance:${key}`) as T | null; return stored && allowed.includes(stored) ? stored : fallback; } catch { return fallback; }
  });
  const update = (next: T) => { setValue(next); try { localStorage.setItem(`dsh-performance:${key}`, next); } catch { /* not remembered */ } };
  return [value, update] as const;
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* Some desktop carriers deny the async clipboard API. */ }
  const focused = document.activeElement as HTMLElement | null, area = document.createElement('textarea');
  area.value = text; area.setAttribute('aria-hidden', 'true'); area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(area); area.select();
  try { if (!document.execCommand('copy')) throw new Error('复制失败'); } finally { area.remove(); focused?.focus({ preventScroll: true }); }
}
