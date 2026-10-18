import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginCatalog } from '../src/plugins';

test('plugins are the profile\'s bundles minus DSH\'s own, named as they name themselves', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-profile-'));
  try {
    const add = async (name: string, locale?: object) => {
      const dir = join(profile, 'node_modules', name); await mkdir(join(dir, 'locale'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
      if (locale) await writeFile(join(dir, 'locale', 'zh.json'), JSON.stringify(locale));
    };
    await add('dshmarket', { meta: { title: '插件市场' } }); await add('dsh-quick-translate', { name: '快捷翻译' }); await add('plain');
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-quick-translate', 'plain', 'missing'] } } }));
    let now = 0; const catalog = new PluginCatalog([join(profile, 'nowhere'), profile], () => now);
    const list = await catalog.list();
    assert.deepEqual(list.map(p => [p.id, p.label, p.version]), [['dshmarket', '插件市场', '1.2.3'], ['dsh-quick-translate', '快捷翻译', '1.2.3'], ['plain', 'plain', '1.2.3']]);
    await add('late'); await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['late'] } } }));
    assert.equal((await catalog.list()).length, 3, 'read again at most once a minute');
    now = 61_000; assert.deepEqual((await catalog.list()).map(p => p.id), ['late']);
  } finally { await rm(profile, { recursive: true, force: true }); }
});
