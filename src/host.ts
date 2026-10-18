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
type Parts = { sampler: Pick<Sampler, 'sample'>; profiler?: Pick<HostProfiler, 'detail'>; catalog?: Pick<PluginCatalog, 'list'> };
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
        default: throw new Error('不支持的监控操作。');
      }
    } catch (error) {
      return json({ error: { message: error instanceof Error ? error.message : '读取运行指标失败。' } }, 400);
    }
  };
}
export function apply(ctx: HostContext) {
  const catalog = new PluginCatalog(), profiler = new HostProfiler(() => catalog.current());
  // The plugin list is read before the first reading arrives, so the first window already knows the plugins.
  void catalog.list(); void profiler.start();
  const sampler = new Sampler(undefined, undefined, () => catalog.current(), profiler);
  ctx.connection.fetch.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: createHandler({ sampler, profiler, catalog }) });
  ctx.effect(() => () => { profiler.dispose(); sampler.dispose(); }, 'performance: collector and profiler');
}
