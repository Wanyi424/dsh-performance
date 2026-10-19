import React, { useEffect, useRef, useState } from 'react';
import { About } from './about';
import type { Group } from './contracts';
import { Details, GroupView, Updated, type View } from './details';
import { Back, Close, Down, Up } from './icons';
import { commandSummary, keyOf, programName, programTitle, programs } from './insights';
import { GROUP_LABEL, KIND, ownerName } from './labels';
import { HostView, OwnerView } from './owner';
import { groupKey } from './tracking';

/** What a key is called: the drawer's title bar, and the way back to it from one level deeper. */
function describe(key: string, view: View): { title: string; kind: string } {
  if (key === 'about') return { title: '这些数字怎么来的', kind: '说明' };
  if (key.startsWith('group:')) { const group = key.slice(6) as Group; return { title: GROUP_LABEL[group], kind: group === 'tools' ? 'DSH 启动的程序' : 'DSH 的组成部分' }; }
  if (key.startsWith('owner:')) { const id = key.slice(6); return { title: ownerName(id, view.plugins), kind: id.startsWith('plugin:') ? '插件' : '后台的一部分' }; }
  const own = view.sample?.processes.find(p => p.kind !== 'tool' && keyOf(p) === key);
  if (own) return { title: KIND[own.kind].label, kind: '进程' };
  const program = programs(view.sample?.processes ?? []).find(p => p.key === key), record = view.tracked.programs.find(r => r.key === key);
  if (program) return { title: programTitle(programName(program.lead.name), commandSummary(program.lead.detail)), kind: '程序' };
  return record ? { title: programTitle(record.name, record.summary), kind: '程序' } : { title: '已不在运行', kind: '' };
}
function Body({ k, view, onOpen }: { k: string; view: View; onOpen(key: string): void }) {
  if (k === 'about') return <About sample={view.sample} />;
  if (k === groupKey('host')) return <HostView view={view} onOpen={onOpen} />;
  if (k.startsWith('group:')) return <GroupView group={k.slice(6) as Group} view={view} onOpen={onOpen} />;
  if (k.startsWith('owner:')) return <OwnerView id={k.slice(6)} view={view} onOpen={onOpen} />;
  return <Details id={k} view={view} onOpen={onOpen} />;
}

/**
 * Details float in from the right over the page, which stays where it was beneath a light scrim; Esc or the scrim closes them.
 * Up and down (or K and J) step through the list's lines in order without closing; opening something from inside goes one
 * level deeper, with the way back at the top left.
 */
export function Drawer({ open, stack, view, order, onClose, onBack, onNav, onOpen }: {
  open: boolean; stack: string[]; view: View; order: string[]; onClose(): void; onBack(): void; onNav(step: 1 | -1): void; onOpen(key: string): void;
}) {
  const key = stack.at(-1), info = key ? describe(key, view) : null, parent = stack.length > 1 ? describe(stack.at(-2)!, view) : null;
  const index = key ? order.indexOf(stack[0]) : -1, steps = !!key && key !== 'about' && index >= 0;
  const scroller = useRef<HTMLDivElement>(null), [scrolled, setScrolled] = useState(false);
  // Each new view starts at its top, with its title focused for keyboard and screen reader users.
  useEffect(() => {
    if (!open) return;
    const el = scroller.current;
    if (el) { el.scrollTop = 0; el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true }); }
    setScrolled(false);
  }, [open, key]);
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('input, textarea, select')) return;
    const k = event.key.toLowerCase();
    if (steps && (k === 'j' || k === 'k')) { event.preventDefault(); onNav(k === 'j' ? 1 : -1); }
    else if (parent && event.key === 'Backspace') { event.preventDefault(); onBack(); }
  };
  return <div className="dpm-layer" data-open={open || undefined}>
    <div className="dpm-scrim" onClick={onClose} />
    <aside className="dpm-drawer" role="dialog" aria-modal="true" aria-label={info?.title} aria-hidden={!open} data-scrolled={scrolled || undefined} onKeyDown={keys}>
      {key && info && <>
        <div className="dpm-drawer-top">
          {parent ? <button type="button" className="dpm-crumb" title="返回（Backspace）" onClick={onBack}><Back size={14} /><span>{parent.title}</span></button>
            : <span className="dpm-drawer-kind">{info.kind}</span>}
          <span className="dpm-spacer" />
          {steps && <>
            <button type="button" className="dpm-icon-button" aria-label="上一项" title="上一项（K）" disabled={index <= 0} onClick={() => onNav(-1)}><Up /></button>
            <button type="button" className="dpm-icon-button" aria-label="下一项" title="下一项（J）" disabled={index >= order.length - 1} onClick={() => onNav(1)}><Down /></button>
            <span className="dpm-drawer-sep" aria-hidden="true" />
          </>}
          <button type="button" className="dpm-icon-button" aria-label="关闭" title="关闭（Esc）" onClick={onClose}><Close /></button>
        </div>
        <div ref={scroller} className="dpm-drawer-scroll" onScroll={event => setScrolled(event.currentTarget.scrollTop > 4)}>
          <div key={key} className="dpm-drawer-content"><Body k={key} view={view} onOpen={onOpen} /><Updated sample={view.sample} /></div>
        </div>
      </>}
    </aside>
  </div>;
}
