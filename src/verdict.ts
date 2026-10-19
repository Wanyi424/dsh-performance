import { GROUPS, type Group, type Point, type Sample } from './contracts';
import { bytes, cpu, duration, span, spaced } from './format';
import { commandSummary, firstAt, programName, programTitle, programs, sum } from './insights';
import { GROUP_LABEL } from './labels';
import type { Frame } from './responsiveness';
import { groupKey } from './tracking';

const MB = 1024 ** 2;
/**
 * The rules behind the one-line conclusion and the sidebar's alert dot, kept in this one place: the about view lists them
 * from here, so what the page says and why never drift apart. CPU is a share of the whole machine, as everywhere on the page.
 */
export const RULES = {
  /** DSH working hard enough to mention, not to alert. */
  busy: { cpu: 15, ms: 30_000 },
  /** The machine is busy, and DSH is only a small part of it. */
  machine: { cpu: 80, share: .2, ms: 30_000 },
  high: { cpu: 50, ms: 60_000 },
  /** Growth over the last half hour, judged once at least 20 minutes of it were watched. */
  growth: { bytes: 300 * MB, ms: 1_800_000, minMs: 1_200_000 },
  tight: { used: .9, share: .3 },
  stutter: { count: 3, ms: 300_000, longestMs: 1_000 },
} as const;

export type Level = 'ok' | 'info' | 'warn';
/** One thing worth saying; `subject` is what the rail opens to explain it. */
export interface Finding { id: 'high' | 'stutter' | 'tight' | 'growth' | 'machine' | 'busy'; level: Level; title: string; detail: string; subject?: string }
/** The conclusion: the most important finding (a warning before news), or that all is well; the rest follow it. */
export interface Verdict { level: Level; title: string; detail: string; subject?: string; findings: Finding[] }

/** DSH's and the machine's CPU over the last `ms`, time weighted, and how much of that time was watched. */
function recent(points: Point[], now: number, ms: number) {
  const start = now - ms;
  let dsh = 0, machine = 0, weight = 0, machineWeight = 0;
  for (let i = firstAt(points, start); i < points.length; i++) {
    const p = points[i], w = p.cpu ? p.time - Math.max(start, p.time - p.intervalMs!) : 0;
    if (w <= 0) continue;
    dsh += sum(p.cpu!) * w; weight += w;
    if (p.systemCpu !== null) { machine += p.systemCpu * w; machineWeight += w; }
  }
  return { dsh: weight ? dsh / weight : null, machine: machineWeight ? machine / machineWeight : null, watched: weight >= ms * .8 };
}
/**
 * How much DSH's own memory grew over the last half hour, a minute averaged at each end so one spike is not growth. Programs it
 * started are left out: one starting is a step, not DSH leaking, and they are listed on their own.
 */
function growth(points: Point[], now: number) {
  const seen = points.slice(firstAt(points, now - RULES.growth.ms)).filter(p => p.memory);
  const first = seen[0]?.time, last = seen.at(-1)?.time;
  if (first === undefined || last === undefined || last - first < RULES.growth.minMs) return null;
  const own = GROUPS.filter(g => g !== 'tools'), mean = (list: Point[]) => own.map(g => sum(list.map(p => p.memory![GROUPS.indexOf(g)])) / list.length);
  const head = mean(seen.filter(p => p.time <= first + 60_000)), tail = mean(seen.filter(p => p.time >= last - 60_000));
  const diff = tail.map((v, i) => v - head[i]);
  return { bytes: sum(diff), group: own[diff.indexOf(Math.max(...diff))], since: first };
}
/** The biggest CPU user right now: a part of DSH, or one program it started. */
export function topUser(sample: Sample): { key: string; name: string; cpu: number } | null {
  const candidates = [
    ...GROUPS.filter(g => g !== 'tools').map(g => {
      const own = sample.processes.filter(p => p.group === g && p.cpu !== null);
      return { key: groupKey(g), name: GROUP_LABEL[g], cpu: own.length ? sum(own.map(p => p.cpu!)) : null };
    }),
    ...programs(sample.processes).map(p => ({ key: p.key, name: programTitle(programName(p.lead.name), commandSummary(p.lead.detail)), cpu: p.cpu })),
  ];
  return candidates.reduce<{ key: string; name: string; cpu: number } | null>((best, c) => c.cpu !== null && c.cpu > (best?.cpu ?? 0) ? { ...c, cpu: c.cpu } : best, null);
}
function largestMemory(sample: Sample): Group {
  const totals = GROUPS.map(g => sum(sample.processes.filter(p => p.group === g).map(p => p.memory ?? 0)));
  return GROUPS[totals.indexOf(Math.max(...totals))];
}

export function assess(points: Point[], sample: Sample | undefined, frames: Frame[], now: number): Verdict | null {
  if (!sample) return null;
  const findings: Finding[] = [], top = topUser(sample), most = top ? `，其中${top.name}占 ${cpu(top.cpu)}` : '';
  const minute = recent(points, now, RULES.high.ms), half = recent(points, now, RULES.busy.ms);
  const high = minute.watched && minute.dsh !== null && minute.dsh >= RULES.high.cpu;
  if (high) findings.push({ id: 'high', level: 'warn', title: 'DSH 占用很高', detail: spaced(`近 1 分钟平均占整机 CPU ${cpu(minute.dsh)}${most}`), subject: top?.key });
  let count = 0, longest = 0;
  for (let i = firstAt(frames, now - RULES.stutter.ms); i < frames.length; i++) { count++; longest = Math.max(longest, frames[i].duration); }
  if (count >= RULES.stutter.count || longest >= RULES.stutter.longestMs)
    findings.push({ id: 'stutter', level: 'warn', title: '界面出现卡顿', detail: spaced(`近 5 分钟卡顿 ${count} 次，最长 ${duration(longest)}`), subject: groupKey('ui') });
  const system = sample.system, memory = sample.memory;
  if (system && memory !== null && system.memoryUsed >= system.memoryTotal * RULES.tight.used && memory >= system.memoryUsed * RULES.tight.share)
    findings.push({ id: 'tight', level: 'warn', title: '电脑内存紧张', detail: spaced(`整机已用 ${Math.round(system.memoryUsed / system.memoryTotal * 100)}% 的内存，其中 DSH 占 ${bytes(memory)}`), subject: groupKey(largestMemory(sample)) });
  const grew = growth(points, now);
  if (grew && grew.bytes >= RULES.growth.bytes)
    findings.push({ id: 'growth', level: 'warn', title: 'DSH 内存持续上涨', detail: spaced(`近 ${span(now - grew.since)}增加 ${bytes(grew.bytes)}，主要来自${GROUP_LABEL[grew.group]}`), subject: groupKey(grew.group) });
  if (half.watched && half.machine !== null && half.machine >= RULES.machine.cpu && (half.dsh ?? 0) < half.machine * RULES.machine.share)
    findings.push({ id: 'machine', level: 'info', title: '电脑很忙，但主要不是 DSH', detail: spaced(`整机 CPU ${cpu(half.machine)}，DSH 只占 ${cpu(half.dsh)}，其余来自其他程序`) });
  else if (half.watched && !high && half.dsh !== null && half.dsh >= RULES.busy.cpu)
    findings.push({ id: 'busy', level: 'info', title: 'DSH 正在忙', detail: spaced(`近 30 秒平均占整机 CPU ${cpu(half.dsh)}${most}`), subject: top?.key });
  const lead = findings.find(f => f.level === 'warn') ?? findings[0];
  if (lead) return { level: lead.level, title: lead.title, detail: lead.detail, subject: lead.subject, findings };
  // The figures themselves are beside the trend; all-well only says what was checked.
  return { level: 'ok', title: 'DSH 运行正常', detail: '没有发现占用过高、内存上涨或界面卡顿', findings };
}
