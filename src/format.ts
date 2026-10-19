const MB = 1024 ** 2, GB = 1024 ** 3;
export function cpu(value: number | null | undefined) {
  if (value == null) return '—';
  if (value === 0) return '0%';
  if (value < .1) return '<0.1%';
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}
export function bytes(value: number | null | undefined) {
  if (value == null) return '—';
  if (value >= GB) return `${(value / GB).toFixed(2)} GB`;
  return value > 0 && value < MB ? '<1 MB' : `${Math.round(value / MB)} MB`;
}
/** Whole-machine memory, where two decimals would be noise. */
export const gb = (value: number) => `${(value / GB).toFixed(1)} GB`;
export function change(value: number) {
  const abs = Math.abs(value);
  return abs < MB ? '±0 MB' : `${value > 0 ? '+' : '−'}${bytes(abs)}`;
}
/** How long something ran or a range spans. */
export function span(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (minutes < 60) return `${minutes} 分钟`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes / 60} 小时`;
}
/** A short wait in everyday units: a stutter, a reaction, the time a function took. */
export const duration = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} 秒` : `${Math.round(ms)} 毫秒`;
export const clock = (time: number) => new Date(time).toLocaleTimeString('zh-CN', { hourCycle: 'h23' });
export const clockShort = (time: number) => clock(time).slice(0, 5);
export const dateTime = (time: number) => new Date(time).toLocaleString('zh-CN', { hourCycle: 'h23' });
/** A space between Chinese and Latin letters or digits, as the page sets them:「其中Node.js占」→「其中 Node.js 占」. */
export const spaced = (text: string) => text.replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2').replace(/([A-Za-z0-9%])([\u4e00-\u9fa5])/g, '$1 $2');
