import React from 'react';
import { CADENCE } from './contracts';
import { Alert, Chevron, Info, Refresh } from './icons';
import type { Verdict } from './verdict';

/**
 * The page's first line: what the readings add up to. All well is one quiet line; anything worth a look is a tinted card that
 * names the cause and opens it, with any other findings under it. A failed reading takes its place, with a retry.
 */
export function Conclusion({ verdict, error, onRetry, onOpen, onRules }: {
  verdict: Verdict | null; error: string; onRetry(): void; onOpen(key: string): void; onRules(): void;
}) {
  if (error) return <div className="dpm-banner" role="alert">
    <Alert size={18} />
    <p><strong>暂时读不到运行数据</strong><span>{error.replace(/[。.]$/, '')}。下面保留最后一次读数，{CADENCE.failed / 1000} 秒后自动重试。</span></p>
    <button type="button" className="dpm-button" onClick={onRetry}><Refresh size={14} />重试</button>
  </div>;
  if (!verdict) return <div className="dpm-verdict" data-level="loading" aria-busy="true"><span className="dpm-skeleton" /></div>;
  const { level, title, detail, subject, findings } = verdict, others = findings.filter(f => f.title !== title);
  if (level === 'ok') return <section className="dpm-verdict" data-level="ok" aria-label="结论">
    <i className="dpm-verdict-dot" aria-hidden="true" />
    <div className="dpm-verdict-line"><h2>{title}</h2><p>{detail}</p></div>
    <button type="button" className="dpm-link" onClick={onRules}>判断依据</button>
  </section>;
  return <section className="dpm-verdict" data-level={level} aria-label="结论">
    <span className="dpm-verdict-icon" aria-hidden="true">{level === 'warn' ? <Alert size={18} /> : <Info size={18} />}</span>
    <div className="dpm-verdict-body">
      <h2>{title}</h2><p>{detail}</p>
      {others.length > 0 && <ul className="dpm-verdict-more" aria-label="另外">{others.map(f => <li key={f.id}>
        <b>{f.title}</b><span>{f.detail}</span>{f.subject && <button type="button" className="dpm-link" onClick={() => onOpen(f.subject!)}>查看</button>}
      </li>)}</ul>}
    </div>
    <div className="dpm-verdict-actions">
      <button type="button" className="dpm-link" onClick={onRules}>判断依据</button>
      {subject && <button type="button" className="dpm-button" onClick={() => onOpen(subject)}>{level === 'warn' ? '查看原因' : '查看'}<Chevron size={14} /></button>}
    </div>
  </section>;
}
