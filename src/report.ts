import { childLines, foldKey, type Breakdown, type Row } from './breakdown';
import type { PluginInfo, Point, Sample } from './contracts';
import { bytes, change, clock, cpu, dateTime, duration, gb, span } from './format';
import { SLOW_INTERACTION_MS, summarize, summarizeResponse } from './insights';
import { SELF } from './labels';
import type { ResponseLog } from './responsiveness';
import type { Verdict } from './verdict';

const cell = (text: string) => text.replace(/\|/g, '\\|');
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => i ? '---:' : '---').join(' | ')} |`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)];

/**
 * The page as Markdown, for an issue or a chat: enough for a reader to tell whether DSH, a program or a plugin is at fault.
 * Programs appear by name only: command lines and paths can carry user names, project names or tokens.
 */
export function report({ now, rangeMs, rangeLabel, sample, points, response, verdict, rows, plugins }: {
  now: number; rangeMs: number; rangeLabel: string; sample?: Sample; points: Point[]; response: ResponseLog; verdict: Verdict | null; rows: Breakdown; plugins: readonly PluginInfo[];
}) {
  const start = now - rangeMs, s = summarize(points, start, now), version = plugins.find(p => p.id === SELF)?.version;
  const out = ['# DSH 运行监控报告', '', `- 时间：${dateTime(now)}，统计最近 ${rangeLabel}`];
  if (verdict) out.push(`- 结论：${verdict.title}。${verdict.detail}。`, ...verdict.findings.filter(f => f.title !== verdict.title).map(f => `- 另外：${f.title}。${f.detail}。`));
  if (sample) out.push(`- 电脑：${sample.cores} 个逻辑处理器${sample.system ? `，内存 ${gb(sample.system.memoryTotal)}` : ''}；DSH 已运行 ${span(sample.time - sample.started)}`);

  const system = sample?.system, at = (time: number | null) => time === null ? '' : `（${clock(time)}）`;
  out.push('', '## 资源占用', '', ...table(['', '当前', `${rangeLabel}平均`, `${rangeLabel}峰值`], [
    ['DSH CPU（占整机）', cpu(sample?.cpu), cpu(s.averageCpu), `${cpu(s.peakCpu)}${at(s.peakCpuAt)}`],
    ['DSH 内存', bytes(sample?.memory), '—', `${bytes(s.peakMemory)}${at(s.peakMemoryAt)}`],
    ['整机 CPU', cpu(system?.cpu), '—', '—'],
    ['整机内存', system ? `${gb(system.memoryUsed)} / ${gb(system.memoryTotal)}` : '—', '—', '—'],
  ]));
  if (s.memoryChange !== null && s.since !== null) out.push('', `DSH 内存较 ${span(now - s.since)}前 ${change(s.memoryChange)}。`);

  // Every line, folded plugins included, in the order the list shows them open.
  const lines = (list: Row[], depth = 0): string[][] => list.flatMap(r => [[`${depth ? '└ ' : ''}${r.name}${r.tag ? `（插件：${r.tag}）` : ''}`, cpu(r.cpu), bytes(r.memory)],
    ...lines(childLines(r, new Set([foldKey(r.key)])), depth + 1)]);
  out.push('', `## 各部分（CPU 为 ${rangeLabel}平均，内存为当前）`, '', ...table(['部分', '平均 CPU', '内存'], lines(rows.dsh)));
  const memory = sample?.attribution?.memory;
  if (memory) out.push('', `插件内存为 ${clock(memory.at)} 读取的抽样估算，只含${sample?.attribution?.since ? ` ${clock(sample.attribution.since)} 起` : '统计开始后'}分配、仍在占用的部分。`);
  out.push('', '## DSH 启动的程序', '');
  out.push(...rows.programs.length ? table(['程序', '平均 CPU', '内存'], lines(rows.programs)) : ['目前没有。']);
  if (rows.ended.length) out.push('', `已退出：${rows.ended.map(r => r.name).join('、')}`);

  const rs = summarizeResponse(response.frames, response.interactions, response.spans, start, now);
  out.push('', '## 界面响应', '');
  if (!response.supported.frames && !response.supported.interactions) out.push('- 当前环境不支持监测');
  else if (!rs.observedMs) out.push('- 窗口可见时才记录，目前还没有记录');
  else out.push(
    `- 卡顿 ${rs.frames} 次${rs.longestFrame === null ? '' : `，最长 ${duration(rs.longestFrame)}${at(rs.longestFrameAt)}`}`,
    `- 超过 ${SLOW_INTERACTION_MS} 毫秒的慢交互 ${rs.slow} 次${rs.slowest === null ? '' : `，最慢 ${duration(rs.slowest)}`}`,
    `- 记录时长 ${span(rs.observedMs)}`,
  );
  out.push('', `> 由运行监控${version ? ` v${version} ` : ''}生成。插件占用是后台的自我抽样估算；报告只列程序名，不含命令行和文件路径。`);
  return out.join('\n');
}
