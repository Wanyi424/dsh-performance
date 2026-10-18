import { ANALYSIS_SECONDS, API_PATH } from './contracts';
import { Analyzer } from './analysis';
import { Sampler } from './collector';
import { PluginCatalog } from './plugins';
export const name = 'performance';
export const inject = ['connection'];
export interface HostContext {
  effect(fn: () => (() => unknown), label?: string): unknown;
  connection: { fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): unknown } };
}
type Parts = { sampler: Pick<Sampler, 'sample'>; analyzer?: Pick<Analyzer, 'start' | 'status' | 'cancel'>; catalog?: Pick<PluginCatalog, 'list'> };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** The page's only door to the Host: fixed actions, no PIDs, paths or commands accepted from the page. */
export function createHandler({ sampler, analyzer, catalog }: Parts) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await request.json();
      switch (body?.action) {
        case 'sample': return json({ data: await sampler.sample() });
        case 'plugins': return json({ data: (await catalog?.list() ?? []).map(({ id, label, version }) => ({ id, label, version })) });
        case 'analysis': return json({ data: analyzer?.status() ?? { state: 'idle' } });
        case 'cancel': return json({ data: analyzer?.cancel() ?? { state: 'idle' } });
        case 'analyze': {
          if (!analyzer) throw new Error('不支持分析。');
          if (!(ANALYSIS_SECONDS as readonly number[]).includes(body.seconds)) throw new Error('不支持的分析时长。');
          return json({ data: await analyzer.start(body.seconds) });
        }
        default: throw new Error('不支持的监控操作。');
      }
    } catch (error) {
      return json({ error: { message: error instanceof Error ? error.message : '读取运行指标失败。' } }, 400);
    }
  };
}
export function apply(ctx: HostContext) {
  const catalog = new PluginCatalog();
  const sampler = new Sampler(undefined, undefined, () => catalog.current()), analyzer = new Analyzer(() => catalog.list());
  ctx.connection.fetch.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: createHandler({ sampler, analyzer, catalog }) });
  ctx.effect(() => () => { analyzer.dispose(); sampler.dispose(); }, 'performance: collector and analyzer');
}
