// Playwright check of the built client in an isolated DSH-like carrier. Requests are answered by page.route, so no local port
// is needed; the collector readings are a scripted scenario, while stutters and slow interactions are real Chromium events.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import type { Attribution, OwnerDetail, ProcessMetric, Sample } from '../src/contracts';
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['tests/browser-entry.tsx'], outfile: 'artifacts/browser-entry.js', bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error' });
const theme = JSON.parse(await readFile('tests/themes.json', 'utf8'));
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{${theme.light}}html[data-theme=dark]{${theme.dark}}*{box-sizing:border-box}body{margin:0;height:100vh;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);overflow:hidden}.shell{display:grid;grid-template-columns:280px minmax(0,1fr);height:100%}.shell>aside{background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;padding:28px 12px 6px;gap:12px;font-size:14px}.shell>aside h2{font-size:21px;margin:0 8px 20px}.shell>aside button{font:inherit;background:transparent;border:0;color:inherit;text-align:left;cursor:pointer}#footer-action{margin-top:auto;display:flex}#main{height:100%;overflow:hidden;min-width:0}.avatar{border-top:1px solid var(--dsw-alias-border-l2);padding:14px 8px 8px;font-size:13px;color:var(--dsw-alias-label-secondary)}body[data-collapsed=true] .shell{grid-template-columns:56px minmax(0,1fr)}body[data-collapsed=true] .shell>aside{padding:20px 10px;align-items:center}body[data-collapsed=true] .shell>aside h2,body[data-collapsed=true] .nav,body[data-collapsed=true] .avatar{display:none}</style></head><body><div class="shell"><aside><h2>deepseek HARNESS</h2><button id="collapse" aria-label="切换侧栏">☰</button><button class="nav" id="close-panel">工作台</button><div id="footer-action"></div><div class="avatar">◉　用户</div></aside><div id="main"></div></div><script src="/entry.js"></script><script src="/client.js"></script></body></html>`;

// The scenario: DSH mostly idles with a little noise; the agent works in bursts; a terminal runs a dev server that rebuilds now
// and then; the agent runs `git status` every couple of minutes; an MCP server keeps running; the interface slowly grows.
const MB = 1024 ** 2, START = Date.now();
let calls = 0, fail = false, profiling = true, clock: number | undefined;
const noise = (n: number, k: number) => { const v = Math.sin(n * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
const born = new Map<number, number>();
const proc = (pid: number, parent: number, kind: ProcessMetric['kind'], group: ProcessMetric['group'], memory: number, cpu: number, name = 'DeepSeek Harness.exe', detail: string | null = null, extra: Partial<ProcessMetric> = {}): ProcessMetric => {
  if (!born.has(pid)) born.set(pid, kind === 'tool' ? clock ?? Date.now() : START - 7_380_000);
  return { pid, parent, created: born.get(pid)!, name, kind, group, threads: 12, detail, cpu: Math.max(0, cpu), memory: memory * MB, ...extra };
};
function sample(): Sample {
  const n = calls, drift = Math.sin(n / 45), agent = n % 160 > 120 ? 3 + noise(n, 1) * 4 : 0, scroll = n % 97 < 2 ? 5 : 0;
  const shell = n >= 90 && n < 380, rebuild = shell && (n - 90) % 41 < 2 ? 8 + noise(n, 2) * 4 : 0, git = n % 70 >= 50 && n % 70 < 52;
  const processes = [
    proc(100, 1, 'main', 'app', 158, .2 + noise(n, 3) * .2), proc(101, 100, 'gpu', 'gpu', 172 + drift * 4, .5 + noise(n, 4) * .4 + scroll * .3),
    proc(102, 100, 'network', 'app', 54, .1 + agent * .05), proc(103, 100, 'renderer', 'ui', 236 + n * .25, 1 + drift * .3 + noise(n, 5) * .6 + scroll + agent * .3),
    proc(104, 100, 'host', 'host', 214 + drift * 10 + agent * 4, .6 + noise(n, 6) * .4 + agent),
    proc(120, 104, 'tool', 'tools', 46, .1 + noise(n, 7) * .1, 'python.exe', 'python.exe -m mcp_server_git --repository D:\\work\\app'),
    proc(140, 104, 'tool', 'tools', 38, .3 + noise(n, 10) * .2, 'context-indexer.exe', '"C:\\Users\\me\\.dsh\\profiles\\desktop\\node_modules\\dsh-context\\bin\\context-indexer.exe" --watch', { plugin: 'dsh-context' }),
    ...shell ? [proc(110, 104, 'tool', 'tools', 30, .05), proc(111, 110, 'tool', 'tools', 62, .2, 'pwsh.exe', 'pwsh.exe -NoLogo -NoProfile'),
      proc(112, 111, 'tool', 'tools', 280 + Math.min(n - 90, 60) * 2, .6 + noise(n, 8) * .5 + rebuild, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "D:\\work\\app\\node_modules\\vite\\bin\\vite.js" --port 5173', { path: 'C:\\Program Files\\nodejs\\node.exe' })] : [],
    ...git ? [proc(130 + Math.floor(n / 70), 104, 'tool', 'tools', 14, 3.5, 'git.exe', 'git.exe status --porcelain')] : [],
  ];
  const cpu = processes.reduce((a, p) => a + p.cpu!, 0), memory = processes.reduce((a, p) => a + p.memory!, 0);
  return { time: clock ?? Date.now(), intervalMs: 2000, cores: 16, started: Date.now() - 7_380_000, unavailable: 0, collector: { pid: 300, cpu: .04, memory: 5 * MB },
    system: { cpu: Math.min(100, cpu + 18 + drift * 5 + noise(n, 9) * 4), memoryUsed: 9.4 * 1024 ** 3 + memory - 1000 * MB, memoryTotal: 15.9 * 1024 ** 3 }, cpu, memory, processes,
    attribution: split(n, agent) };
}
// The Host's own split of its main thread: the notes plugin re-renders in bursts, the agent's work is DSH's, the monitor costs
// a little on every reading. Memory is read every 150 readings (5 minutes); the notes plugin's grows a little each time. The
// page can pause the split, and the readings then carry none.
let read: Attribution['memory'] = null;
function split(n: number, agent: number): Attribution {
  if (n >= 30 && (n - 30) % 150 === 0) {
    const k = (n - 30) / 150;
    read = { at: clock ?? Date.now(), pauseMs: 84, owners: { 'plugin:dsh-translate': .2 * MB, 'plugin:dsh-markdown-notes': (6 + k * 1.5) * MB, 'plugin:dsh-performance': 1.2 * MB,
      'plugin:dsh-context': 3.1 * MB, core: 48 * MB, gc: 0, other: 6.4 * MB } };
  }
  const notes = n % 50 < 8 ? .5 + noise(n, 11) * .4 : 0;
  return { state: profiling ? 'running' : 'paused', since: START, startPauseMs: 286, error: null, memory: read, cpu: n === 0 || !profiling ? null : { 'plugin:dsh-translate': 0, 'plugin:dsh-markdown-notes': notes,
    'plugin:dsh-performance': .03 + noise(n, 12) * .02, 'plugin:dsh-context': .01 + agent * .01, core: .08 + agent * .12, gc: .02 + agent * .02, other: .01 } };
}
const PLUGINS = [{ id: 'dsh-translate', label: '翻译', version: '0.2.4' }, { id: 'dsh-markdown-notes', label: 'Markdown 笔记', version: '0.5.2' },
  { id: 'dsh-performance', label: 'DSH 性能监控', version: '0.7.2' }, { id: 'dsh-context', label: '上下文 (dsh-context)', version: '0.71.0' }];
const hot = (name: string, where: string, value: number) => ({ name, where, value });
const DETAIL: Record<string, OwnerDetail> = {
  'plugin:dsh-markdown-notes': { cpu: [hot('renderMarkdown', 'lib/host.js:1040', 2_400), hot('watch', 'lib/host.js:77', 310)], memory: [hot('renderMarkdown', 'lib/host.js:1040', 5.2 * MB), hot('remember', 'lib/host.js:212', 1.1 * MB)], memoryAt: null },
  'plugin:dsh-performance': { cpu: [hot('take', 'lib/host.js:612', 820), hot('calculate', 'lib/host.js:212', 610), hot('handler', 'lib/host.js:388', 228)], memory: [hot('bank', 'lib/host.js:655', .8 * MB)], memoryAt: null },
  core: { cpu: [hot('@deepseek-ai/dsh-agent-loop', '', 5_200), hot('@deepseek-ai/dsh-session', '', 1_900), hot('Node.js', '', 700)], memory: [hot('@deepseek-ai/dsh-session', '', 30 * MB)], memoryAt: null },
};
function answer(body: { action: string; id?: string; enabled?: boolean }) {
  if (body.action === 'sample') { calls++; return fail ? null : sample(); }
  if (body.action === 'plugins') return PLUGINS;
  if (body.action === 'owner') return { ...DETAIL[body.id!] ?? { cpu: [], memory: [] }, memoryAt: read?.at ?? null };
  if (body.action === 'profiling') { profiling = body.enabled === true; return { state: profiling ? 'running' : 'paused' }; }
  return null;
}
async function serve(page: Page) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'dsh.test') return route.abort();
    if (url.pathname === '/api/dsh-performance') {
      const data = answer(JSON.parse(route.request().postData() ?? '{}'));
      return route.fulfill({ status: data === null ? 400 : 200, contentType: 'application/json', body: JSON.stringify(data === null ? { error: { message: '模拟采集失败。' } } : { data }) });
    }
    const file = ({ '/entry.js': 'artifacts/browser-entry.js', '/client.js': 'lib/client.js', '/client.page.js': 'lib/client.page.js' } as Record<string, string>)[url.pathname];
    return route.fulfill(file ? { contentType: 'text/javascript', body: await readFile(file) } : { contentType: 'text/html; charset=utf-8', body: html });
  });
}
const action = (name: string) => (r: { url(): string; request(): { postData(): string | null } }) => r.url().endsWith('/api/dsh-performance') && (r.request().postData() ?? '').includes(`"action":"${name}"`);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1584, height: 1120 } });
  const errors: string[] = [], chunks: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', r => { if (r.url().endsWith('client.page.js')) chunks.push(r.url()); });
  await serve(page); await page.goto('http://dsh.test/');
  await page.getByRole('button', { name: /^DSH 性能监控，CPU/ }).waitFor();
  const entry = page.locator('.dpm-entry'), table = page.locator('.dpm-table'), drawer = page.locator('.dpm-drawer');
  assert.equal(chunks.length, 0);
  await entry.click(); await page.getByRole('heading', { name: 'DSH 性能监控', exact: true }).waitFor();
  assert.equal(chunks.length, 1); assert.equal(await entry.getAttribute('aria-current'), 'page');
  await page.locator('.dpm-verdict h2').waitFor();
  assert.deepEqual(await page.locator('.dpm-head-label').evaluateAll(nodes => nodes.map(node => node.firstChild?.textContent)), ['CPU', '内存', '界面响应']);
  const stall = async () => {
    const frames = await page.evaluate(() => (window as unknown as { runTaskProbe(): Promise<number> }).runTaskProbe());
    await page.evaluate(() => document.querySelector('.dpm-bar h1')!.addEventListener('click', () => { const end = performance.now() + 260; while (performance.now() < end) {} }, { once: true }));
    await page.locator('.dpm-bar h1').click(); await page.waitForTimeout(300); return frames;
  };
  const taskProbe = await stall(); assert.ok(taskProbe >= 6);
  await page.locator('.dpm-verdict[data-level="warn"]').waitFor();
  assert.equal(await entry.getAttribute('data-state'), 'warn');
  assert.equal(await entry.locator('.dpm-entry-dot').count(), 1);
  const statisticsProbe = await page.evaluate(() => (window as unknown as { runStatisticsProbe(): unknown }).runStatisticsProbe());
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hidden = calls; await page.waitForTimeout(3300); assert.equal(calls, hidden);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300); assert.equal(calls, hidden + 1);
  fail = true; await page.locator('.dpm-banner[role="alert"]').waitFor({ timeout: 5000 });
  assert.match(await page.locator('.dpm-banner').innerText(), /模拟采集失败/);
  fail = false; await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.locator('.dpm-banner').waitFor({ state: 'hidden' });
  clock = Date.now(); await page.clock.install({ time: new Date(clock) });
  const reading = async () => { clock! += 2000; const response = page.waitForResponse(action('sample')); await page.clock.runFor(2000); await response; await new Promise(r => setTimeout(r, 10)); };
  for (let i = 0; i < 450; i++) { await reading(); if (i === 330) await stall(); }
  await table.locator('.dpm-row', { hasText: 'Markdown 笔记' }).waitFor();
  const owners = await table.locator('.dpm-row[data-depth="1"][data-group="host"] strong').allInnerTexts();
  assert.equal(owners[0], 'Markdown 笔记'); assert.deepEqual(owners.slice(-2), ['DSH 自身', '其他']);
  assert.match(await table.locator('.dpm-row', { hasText: 'DSH 性能监控' }).innerText(), /dsh-performance · v0\.7\.2 · 自带 1 个程序/);
  assert.ok(await page.locator('.dpm-area').count() >= 5);
  assert.ok(await page.locator('.dpm-life').count() >= 1 && await page.locator('.dpm-blip').count() >= 1);
  await table.getByRole('button', { name: /已退出的程序/ }).click();
  assert.match((await table.locator('.dpm-row[data-ended]').allInnerTexts()).join('\n'), /Git/);
  await table.getByRole('button', { name: '内存', exact: true }).click();
  assert.equal(await table.getByRole('button', { name: '内存', exact: true }).getAttribute('aria-pressed'), 'true');
  await table.getByRole('button', { name: 'CPU', exact: true }).click();
  await page.locator('.dpm-scroll').evaluate(el => { el.scrollTop = 0; }); await page.mouse.move(0, 0);
  await page.screenshot({ animations: 'disabled', path: 'artifacts/light-top.png' });
  await page.locator('.dpm-key[data-group="tools"]').hover();
  assert.equal(await page.locator('.dpm-root').getAttribute('data-focus'), 'tools');
  const canvas = await page.locator('.dpm-canvas').boundingBox();
  await page.mouse.move(canvas!.x + canvas!.width * .62, canvas!.y + 70);
  await page.locator('.dpm-tooltip').waitFor();
  assert.match(await page.locator('.dpm-tooltip').innerText(), /后台[\s\S]*DSH 合计[\s\S]*整机/);
  await page.mouse.move(0, 0);
  const closeDrawer = async () => { await drawer.getByRole('button', { name: '关闭', exact: true }).click(); await page.clock.runFor(400); await drawer.waitFor({state:'hidden'}); };
  await table.locator('.dpm-name-button').filter({ hasText: 'Python' }).click();
  await drawer.getByRole('heading', {name: /Python/}).waitFor();
  assert.match(await drawer.innerText(), /进程号（PID）[\s\S]*命令行[\s\S]*mcp_server_git/);
  await closeDrawer();
  const note = table.getByRole('button', {name:'Markdown 笔记',exact:true});
  await note.click(); await drawer.locator('.dpm-hot li').first().waitFor();
  assert.match(await drawer.innerText(), /renderMarkdown[\s\S]*lib\/host\.js:1040/);
  await page.clock.runFor(400); await page.screenshot({animations:'disabled',path:'artifacts/detail-plugin.png'});
  await drawer.press('Escape'); await page.clock.runFor(400); await drawer.waitFor({state:'hidden'});
  await page.locator('.dpm-key[data-group="host"]').click();
  const pause = page.waitForResponse(action('profiling'));
  await drawer.getByRole('button', {name:/暂停统计/}).click(); await pause; assert.equal(profiling,false);
  await reading(); await drawer.locator('.dpm-chip', {hasText:'已暂停'}).waitFor();
  const resume = page.waitForResponse(action('profiling'));
  await drawer.getByRole('button', {name:/继续统计/}).click(); await resume; assert.equal(profiling,true);
  await reading(); await drawer.getByRole('button', {name:/暂停统计/}).waitFor();
  await closeDrawer();
  await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } })`);
  await page.getByRole('button',{name:'复制诊断报告'}).click();
  await page.locator('.dpm-toast').filter({hasText:'已复制诊断报告'}).waitFor();
  const copied=await page.evaluate(()=>(window as unknown as {copied:string}).copied);
  assert.match(copied,/^# DSH 性能监控报告\n[\s\S]*## 各部分[\s\S]*└ Markdown 笔记[\s\S]*## DSH 启动的程序[\s\S]*## 界面响应/);
  assert.doesNotMatch(copied,/--repository|--port|D:\\work|node_modules/);
  await page.getByRole('button',{name:'这些数字怎么来的'}).click();
  await drawer.getByRole('heading',{name:'插件是怎么统计的'}).waitFor();
  assert.match(await drawer.innerText(),/这次是 286 毫秒[\s\S]*最近一次停顿 84 毫秒/);
  await closeDrawer();
  await page.getByRole('button',{name:'1 小时',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'1 小时',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'15 分钟',exact:true}).click();
  await page.clock.runFor(3000);
  await page.locator('.dpm-scroll').evaluate(el=>{el.scrollTop=0;}); await page.mouse.move(0,0);
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';}); await page.clock.runFor(400);
  await page.screenshot({animations:'disabled',path:'artifacts/dark.png'});
  await page.evaluate(()=>{delete document.documentElement.dataset.theme;});
  await page.getByRole('button',{name:'切换侧栏'}).click(); assert.equal(await page.locator('.dpm-entry.dpm-compact').count(),1);
  await page.setViewportSize({width:560,height:1000}); await page.clock.runFor(400);
  assert.equal(await page.locator('.dpm-scroll').evaluate(el=>el.scrollWidth>el.clientWidth),false);
  await page.screenshot({animations:'disabled',path:'artifacts/narrow.png'});
  assert.deepEqual(errors,[]);
  const report={errors,pageLazyLoaded:true,entrySelectedState:true,conclusionAndAlertDot:true,linkedTracks:true,programMarks:true,pluginAttribution:true,drawerDetails:true,profilerPauseResume:true,diagnosticReport:true,sorting:true,visibilityPause:true,errorAndRetry:true,narrowLayout:true,taskProbe,statisticsProbe,data:'scripted collector readings; actual built client; real Chromium long frames and slow click'};
  await writeFile('artifacts/browser-check.json',JSON.stringify(report,null,2)); console.log(report);
} finally {await browser.close();}
