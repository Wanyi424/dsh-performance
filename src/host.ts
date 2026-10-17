import { API_PATH } from './contracts';
import { Sampler } from './collector';
export const name = 'performance';
export const inject = ['connection'];
export interface HostContext {
  effect(fn: () => (() => unknown), label?: string): unknown;
  connection: { fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): unknown } };
}
export function createHandler(sampler: Pick<Sampler, 'sample'>) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await request.json();
      if (body?.action !== 'sample') throw new Error('不支持的监控操作。');
      return Response.json({ data: await sampler.sample() }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return Response.json({ error: { message: error instanceof Error ? error.message : '读取运行指标失败。' } }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
export function apply(ctx: HostContext) {
  const sampler = new Sampler();
  ctx.connection.fetch.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: createHandler(sampler) });
  ctx.effect(() => () => sampler.dispose(), 'performance: collector');
}
