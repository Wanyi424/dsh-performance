import { API_PATH } from './contracts';
declare global { interface Window { __DSH_TRANSPORT__?: { fetch?: typeof fetch } } }

/** One request to this plugin's Host route, through DSH's transport when it provides one. */
export async function call<T>(action: string, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const fetcher = window.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch.bind(globalThis), timeout = AbortSignal.timeout(8_000);
  const response = await fetcher(API_PATH.slice(1), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? `读取失败（HTTP ${response.status}）`);
  return result.data;
}
