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
export function change(value: number) {
  const abs = Math.abs(value);
  return abs < MB ? '±0 MB' : `${value > 0 ? '+' : '−'}${bytes(abs)}`;
}
export function span(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (minutes < 60) return `${minutes} 分钟`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes / 60} 小时`;
}
export const clock = (time: number) => new Date(time).toLocaleTimeString('zh-CN', { hourCycle: 'h23' });
export const clockShort = (time: number) => clock(time).slice(0, 5);
export const ms = (value: number) => `${Math.round(value)} ms`;
