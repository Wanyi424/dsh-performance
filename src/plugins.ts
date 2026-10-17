import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginInfo } from './contracts';

/** An installed plugin and the folder its code is loaded from. */
export interface PluginDir extends PluginInfo { dir: string }
/** Bundles of this scope are DSH's own composition, not plugins. */
const CORE_SCOPE = '@deepseek-ai/';

async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, 'utf8')); }
/** The name the plugin gives itself in its locale file (`meta.title` or `name`), else its package name. */
async function label(dir: string, fallback: string) {
  for (const file of ['zh.json', 'zh-CN.json', 'en.json']) {
    try { const locale = await json(join(dir, 'locale', file)), value = locale?.meta?.title ?? locale?.name; if (typeof value === 'string' && value.trim()) return value.trim(); } catch { /* next */ }
  }
  return fallback;
}

/**
 * The plugins of the profile the Host runs in, read from the profile's own record of installed bundles. The profile is the
 * Host's working directory, or else the one whose node_modules holds this plugin. Read again at most once a minute.
 */
export class PluginCatalog {
  private cached: PluginDir[] = [];
  private readAt = 0;
  private reading?: Promise<PluginDir[]>;
  constructor(private readonly profiles = [process.cwd(), fileURLToPath(new URL('../../..', import.meta.url))], private readonly now = () => Date.now()) {}
  /** The last list read, refreshed in the background when stale; for callers that cannot wait. */
  current() { void this.list(); return this.cached; }
  list(): Promise<PluginDir[]> {
    if (this.now() - this.readAt < 60_000) return Promise.resolve(this.cached);
    return this.reading ??= this.read().then(list => { this.cached = list; this.readAt = this.now(); return list; }).finally(() => { this.reading = undefined; });
  }
  private async read(): Promise<PluginDir[]> {
    for (const profile of this.profiles) {
      let bundles: unknown;
      try { bundles = (await json(join(profile, 'package.json')))?.dsh?.profile?.bundles; } catch { continue; }
      if (!Array.isArray(bundles)) continue;
      const names = bundles.filter((name): name is string => typeof name === 'string' && !name.startsWith(CORE_SCOPE));
      const found = await Promise.all(names.map(async id => {
        try {
          const dir = await realpath(join(profile, 'node_modules', id)), pkg = await json(join(dir, 'package.json'));
          return { id, dir, version: typeof pkg?.version === 'string' ? pkg.version : '', label: await label(dir, id) };
        } catch { return null; }
      }));
      return found.filter((p): p is PluginDir => p !== null);
    }
    return [];
  }
}
