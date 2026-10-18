import React, { useEffect, useId, useRef, useState } from 'react';
import { Close } from './icons';

/**
 * Native modal dialog: focus trap, Esc and top layer come from the browser. Esc, the backdrop and the close button play the
 * exit animation before `onClose`.
 */
export function Dialog({ title, lead, className = '', onClose, children }: { title: string; lead?: React.ReactNode; className?: string; onClose(): void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId(), [leaving, setLeaving] = useState(false);
  const dismiss = () => setLeaving(true);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`dpm-dialog ${className}`} aria-labelledby={id} data-leaving={leaving || undefined}
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClick={event => { if (event.target === event.currentTarget) dismiss(); }}
    onAnimationEnd={event => { if (leaving && event.target === event.currentTarget && !event.pseudoElement) onClose(); }}>
    <header>{lead}<h2 id={id}>{title}</h2><button type="button" className="dpm-icon-button" aria-label="关闭" title="关闭" onClick={dismiss}><Close /></button></header>
    <div className="dpm-dialog-body">{children}</div>
  </dialog>;
}

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

/**
 * Rows follow the chosen order on every reading, except while the pointer rests on the table: then they hold their places, so
 * the row about to be clicked does not move away. New rows join at the end until the pointer leaves.
 */
export function useSteadyOrder(keys: string[], held: boolean) {
  const order = useRef<string[]>([]);
  if (!held) order.current = keys;
  else { const present = new Set(keys); order.current = [...order.current.filter(k => present.has(k)), ...keys.filter(k => !order.current.includes(k))]; }
  return order.current;
}
