import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Attributor, ownersOf, top, type CpuProfile, type HeapNode } from '../src/attribution';

// Absolute the way the platform makes them (a drive letter on Windows), as real install and profile folders are.
const root = resolve('/', 'app', 'DeepSeek Harness'), profile = resolve('/', 'home', 'u', '.dsh', 'profiles', 'desktop');
const plugins = [{ id: 'dsh-notes', label: '笔记', version: '1', dir: join(profile, 'node_modules', 'dsh-notes') }, { id: 'dsh-idle', label: '闲', version: '1', dir: join(profile, 'node_modules', 'dsh-idle') }];
const url = (...parts: string[]) => pathToFileURL(join(...parts)).href;
const core = url(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js');
const notes = url(profile, 'node_modules', 'dsh-notes', 'lib', 'host.js');
const katex = url(profile, 'node_modules', 'katex', 'dist', 'katex.js');
const frame = (functionName: string, at = '', lineNumber = 0) => ({ functionName, url: at, lineNumber });

test('samples go to the nearest plugin frame on the stack, else to the DSH package or what is left', () => {
  // root ─ idle · gc · program · loop(core) ─ render(notes) ─ parse(core, called by the plugin) · loop ─ tick(core) · typeset(katex)
  const cpu: CpuProfile = {
    startTime: 0, endTime: 10_000_000,
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 3, 4, 5, 9] }, { id: 2, callFrame: frame('(idle)') }, { id: 3, callFrame: frame('(garbage collector)') },
      { id: 4, callFrame: frame('(program)') }, { id: 5, callFrame: frame('loop', core, 9), children: [6, 8] },
      { id: 6, callFrame: frame('render', notes, 41), children: [7] }, { id: 7, callFrame: frame('parse', core, 99) }, { id: 8, callFrame: frame('tick', core, 120) },
      { id: 9, callFrame: frame('typeset', katex) },
    ],
    // One sample per millisecond-long stretch; times in µs.
    samples: [2, 2, 2, 2, 6, 7, 7, 8, 3, 4, 9], timeDeltas: [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  };
  cpu.endTime = 11_000;
  const r = new Attributor(root).cpu(cpu, plugins), by = (id: string) => r.owners.get(id);
  assert.equal(r.durationMs, 11); assert.equal(r.busyMs, 7);
  assert.equal(by('plugin:dsh-notes')!.value, 3, 'its own frame and the DSH code it called');
  assert.deepEqual(top(by('plugin:dsh-notes')!.hot), [{ name: 'render', where: 'lib/host.js:42', value: 3 }]);
  assert.equal(by('plugin:dsh-idle'), undefined, 'a plugin without samples has nothing booked');
  assert.deepEqual(ownersOf(plugins), ['plugin:dsh-notes', 'plugin:dsh-idle', 'core', 'gc', 'other'], 'yet every installed plugin is an owner');
  assert.equal(by('core')!.value, 1); assert.deepEqual(top(by('core')!.hot), [{ name: '@deepseek-ai/dsh-agent-loop', where: '', value: 1 }]);
  assert.equal(by('gc')!.value, 1); assert.equal(by('gc')!.hot.size, 0);
  assert.equal(by('other')!.value, 2, 'native time and a package that is neither DSH nor a plugin');
  assert.deepEqual([...by('other')!.hot.keys()].sort(), ['katex', '原生代码']);
});

test('live allocations are charged by their allocation stacks', () => {
  const heap: HeapNode = { callFrame: frame('(root)'), selfSize: 0, children: [
    { callFrame: frame('loop', core), selfSize: 100, children: [{ callFrame: frame('render', notes, 9), selfSize: 400, children: [{ callFrame: frame('parse', core), selfSize: 50, children: [] }] }] },
  ] };
  const r = new Attributor(root).heap(heap, plugins);
  assert.equal(r.bytes, 550); assert.equal(r.owners.get('plugin:dsh-notes')!.value, 450); assert.equal(r.owners.get('core')!.value, 100);
  assert.deepEqual(top(r.owners.get('plugin:dsh-notes')!.hot), [{ name: 'render', where: 'lib/host.js:10', value: 450 }]);
});

test('scripts are classified again when the list of plugins changes', () => {
  const a = new Attributor(root), profile: CpuProfile = { startTime: 0, endTime: 2000, nodes: [{ id: 1, callFrame: frame('(root)'), children: [2] }, { id: 2, callFrame: frame('render', notes) }], samples: [2, 2], timeDeltas: [0, 1000] };
  assert.equal(a.cpu(profile, plugins).owners.get('plugin:dsh-notes')!.value, 2);
  assert.equal(a.cpu(profile, []).owners.get('other')!.value, 2, 'uninstalled: no longer a plugin');
});
