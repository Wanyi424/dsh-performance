import { API_PATH } from './contracts';
import { Sampler } from './collector';
import { PluginCatalog } from './plugins';
import { HostProfiler } from './profiler';
export const name = 'performance';
export const inject = ['connection'];
export interface HostContext {
  effect(fn: () => (() => unknown), label?: string): unknown;
  connection: { fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): unknown } };
}
type Parts = { sampler: Pick<Sampler, 'sample'>; profiler?: Pick<HostProfiler, 'detail' | 'start' | 'pause' | 'status'>; catalog?: Pick<PluginCatalog, 'list'> };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** The page's only door to the Host: fixed actions, no PIDs, paths or commands accepted from the page. */
export function createHandler({ sampler, profiler, catalog }: Parts) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await request.json();
      switch (body?.action) {
        case 'sample': return json({ data: await sampler.sample() });
        case 'plugins': return json({ data: (await catalog?.list() ?? []).map(({ id, label, version }) => ({ id, label, version })) });
        case 'owner': {
          // An owner id only looks up what the profiler recorded; an unknown one simply has nothing.
          const { id, from, to } = body;
          if (typeof id !== 'string' || id.length > 256 || !Number.isFinite(from) || !Number.isFinite(to)) throw new Error('不支持的查询。');
          return json({ data: profiler?.detail(id, from, to) ?? { cpu: [], memory: [], memoryAt: null } });
        }
        case 'profiling': {
          // The user's pause switch; otherwise the profiler runs from the Host's start.
          if (typeof body.enabled !== 'boolean') throw new Error('不支持的监控操作。');
          if (body.enabled) await profiler?.start(); else profiler?.pause();
          return json({ data: { state: profiler?.status().state ?? 'unavailable' } });
        }
        default: throw new Error('不支持的监控操作。');
      }
    } catch (error) {
      return json({ error: { message: error instanceof Error ? error.message : '读取运行指标失败。' } }, 400);
    }
  };
}
export function apply(ctx: HostContext) {
  const catalog = new PluginCatalog(), profiler = new HostProfiler(() => catalog.current());
  // Profiling starts with the Host, so every reading carries the split and memory counts from here on, page open or not.
  // Frames are charged to plugins when a window closes, by which time the plugin list has been read.
  void catalog.list(); void profiler.start();
  const sampler = new Sampler(undefined, undefined, () => catalog.current(), profiler);
  ctx.connection.fetch.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: createHandler({ sampler, profiler, catalog }) });
  ctx.effect(() => () => { profiler.dispose(); sampler.dispose(); }, 'performance: collector and profiler');
}
