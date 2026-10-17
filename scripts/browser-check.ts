// Playwright check of the built client in an isolated DSH-like carrier. Requests are answered by page.route, so no local port
// is needed; the collector readings are a scripted scenario, while stutters and slow interactions are real Chromium events.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import type { ProcessMetric, Sample } from '../src/contracts';
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['tests/browser-entry.tsx'], outfile: 'artifacts/browser-entry.js', bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error' });
const theme = JSON.parse(await readFile('tests/themes.json', 'utf8'));
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{${theme.light}}html[data-theme=dark]{${theme.dark}}*{box-sizing:border-box}body{margin:0;height:100vh;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);overflow:hidden}.shell{display:grid;grid-template-columns:280px minmax(0,1fr);height:100%}.shell>aside{background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;padding:28px 12px 6px;gap:12px;font-size:14px}.shell>aside h2{font-size:21px;margin:0 8px 20px}.shell>aside button{font:inherit;background:transparent;border:0;color:inherit;text-align:left;cursor:pointer}#footer-action{margin-top:auto;display:flex}#main{height:100%;overflow:hidden;min-width:0}.avatar{border-top:1px solid var(--dsw-alias-border-l2);padding:14px 8px 8px;font-size:13px;color:var(--dsw-alias-label-secondary)}body[data-collapsed=true] .shell{grid-template-columns:56px minmax(0,1fr)}body[data-collapsed=true] .shell>aside{padding:20px 10px;align-items:center}body[data-collapsed=true] .shell>aside h2,body[data-collapsed=true] .nav,body[data-collapsed=true] .avatar{display:none}</style></head><body><div class="shell"><aside><h2>deepseek HARNESS</h2><button id="collapse" aria-label="切换侧栏">☰</button><button class="nav" id="close-panel">工作台</button><div id="footer-action"></div><div class="avatar">◉　用户</div></aside><div id="main"></div></div><script src="/entry.js"></script><script src="/client.js"></script></body></html>`;

// The scenario: DSH mostly idles with a little noise; the agent works in bursts; a shell starts a dev server that rebuilds now
// and then; the agent runs `git status` every couple of minutes; an MCP server keeps running; the renderer slowly grows.
const MB = 1024 ** 2, START = Date.now();
let calls = 0, fail = false, clock: number | undefined;
const noise = (n: number, k: number) => { const v = Math.sin(n * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
const born = new Map<number, number>();
const proc = (pid: number, parent: number, kind: ProcessMetric['kind'], group: ProcessMetric['group'], memory: number, cpu: number, name = 'DeepSeek Harness.exe', detail: string | null = null): ProcessMetric => {
  if (!born.has(pid)) born.set(pid, kind === 'tool' ? clock ?? Date.now() : START - 7_380_000);
  return { pid, parent, created: born.get(pid)!, name, kind, group, threads: 12, detail, cpu: Math.max(0, cpu), memory: memory * MB };
};
function sample(): Sample {
  const n = calls, drift = Math.sin(n / 45), agent = n % 160 > 120 ? 3 + noise(n, 1) * 4 : 0, scroll = n % 97 < 2 ? 5 : 0;
  const shell = n >= 90 && n < 380, rebuild = shell && (n - 90) % 41 < 2 ? 8 + noise(n, 2) * 4 : 0, git = n % 70 >= 50 && n % 70 < 52;
  const processes = [
    proc(100, 1, 'main', 'app', 158, .2 + noise(n, 3) * .2), proc(101, 100, 'gpu', 'gpu', 172 + drift * 4, .5 + noise(n, 4) * .4 + scroll * .3),
    proc(102, 100, 'network', 'app', 54, .1 + agent * .05), proc(103, 100, 'renderer', 'ui', 236 + n * .25, 1 + drift * .3 + noise(n, 5) * .6 + scroll + agent * .3),
    proc(104, 100, 'host', 'host', 214 + drift * 10 + agent * 4, .6 + noise(n, 6) * .4 + agent),
    proc(120, 104, 'tool', 'tools', 46, .1 + noise(n, 7) * .1, 'python.exe', 'python.exe -m mcp_server_git --repository D:\\work\\app'),
    ...shell ? [proc(110, 104, 'tool', 'tools', 30, .05), proc(111, 110, 'tool', 'tools', 62, .2, 'pwsh.exe', 'pwsh.exe -NoLogo -NoProfile'),
      proc(112, 111, 'tool', 'tools', 280 + Math.min(n - 90, 60) * 2, .6 + noise(n, 8) * .5 + rebuild, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "D:\\work\\app\\node_modules\\vite\\bin\\vite.js" --port 5173')] : [],
    ...git ? [proc(130 + Math.floor(n / 70), 104, 'tool', 'tools', 14, 3.5, 'git.exe', 'git.exe status --porcelain')] : [],
  ];
  const cpu = processes.reduce((a, p) => a + p.cpu!, 0), memory = processes.reduce((a, p) => a + p.memory!, 0);
  return { time: clock ?? Date.now(), intervalMs: 2000, cores: 16, started: Date.now() - 7_380_000, unavailable: 0, collector: { pid: 300, cpu: .04, memory: 5 * MB },
    system: { cpu: Math.min(100, cpu + 18 + drift * 5 + noise(n, 9) * 4), memoryUsed: 9.4 * 1024 ** 3 + memory - 1000 * MB, memoryTotal: 15.9 * 1024 ** 3 }, cpu, memory, processes };
}
async function serve(page: Page) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'dsh.test') return route.abort();
    if (url.pathname === '/api/dsh-performance') { calls++; return route.fulfill({ status: fail ? 400 : 200, contentType: 'application/json', body: JSON.stringify(fail ? { error: { message: '模拟采集失败' } } : { data: sample() }) }); }
    const file = ({ '/entry.js': 'artifacts/browser-entry.js', '/client.js': 'lib/client.js', '/client.page.js': 'lib/client.page.js' } as Record<string, string>)[url.pathname];
    return route.fulfill(file ? { contentType: 'text/javascript', body: await readFile(file) } : { contentType: 'text/html; charset=utf-8', body: html });
  });
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [], chunks: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', r => { if (r.url().endsWith('client.page.js')) chunks.push(r.url()); });
  await serve(page);
  await page.goto('http://dsh.test/');
  await page.getByRole('button', { name: /^运行监控，CPU/ }).waitFor();
  const entry = page.locator('.dpm-entry');
  assert.equal(chunks.length, 0, 'the page bundle loads only when opened');
  await entry.click(); await page.getByRole('heading', { name: '运行监控', exact: true }).waitFor();
  assert.equal(chunks.length, 1); assert.equal(await entry.getAttribute('aria-current'), 'page');

  // Real main-thread stalls and one slow click: Chromium's own long-frame and event-timing entries.
  const stall = async () => {
    const frames = await page.evaluate(() => (window as unknown as { runTaskProbe(): Promise<number> }).runTaskProbe());
    await page.evaluate(() => document.querySelector('.dpm-bar h1')!.addEventListener('click', () => { const end = performance.now() + 260; while (performance.now() < end) { /* slow handler */ } }, { once: true }));
    await page.locator('.dpm-bar h1').click(); await page.waitForTimeout(300);
    return frames;
  };
  const taskProbe = await stall();
  assert.ok(taskProbe >= 6, 'the long-frame observer received the stalls');
  await page.waitForFunction(() => /次卡顿/.test(document.querySelectorAll('.dpm-track-head')[2]?.textContent ?? ''));
  const statisticsProbe = await page.evaluate(() => (window as unknown as { runStatisticsProbe(): unknown }).runStatisticsProbe());

  // Hidden windows do not sample; failures show a banner, keep the last reading and recover on retry.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hidden = calls; await page.waitForTimeout(3300); assert.equal(calls, hidden);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300); assert.equal(calls, hidden + 1);
  fail = true; await page.locator('.dpm-banner').waitFor({ timeout: 5000 });
  assert.match(await entry.innerText(), /异常/);
  await page.screenshot({ animations: 'disabled', path: 'artifacts/error.png' });
  fail = false; await page.getByRole('button', { name: '重试', exact: true }).click(); await page.locator('.dpm-banner').waitFor({ state: 'hidden' });

  // Accumulate a quarter of an hour on an accelerated clock through the real sampler; production code has no seeded history.
  clock = Date.now(); await page.clock.install({ time: new Date(clock) });
  for (let i = 0; i < 450; i++) {
    clock += 2000;
    const response = page.waitForResponse(r => r.url().endsWith('/api/dsh-performance'));
    await page.clock.runFor(2000); await response; await new Promise(r => setTimeout(r, 10));
    if (i === 330) await stall();
  }
  for (const label of ['整机 CPU', '整机内存']) await page.locator('.dpm-share-label', { hasText: label }).waitFor();
  for (const label of ['界面渲染', 'GPU', '主进程与服务', '后台服务', '工具进程', '卡顿']) assert.ok(await page.locator('.dpm-keys li', { hasText: label }).count() >= 1, label);
  assert.match(await page.locator('.dpm-track-head').nth(2).innerText(), /次卡顿|流畅/);
  assert.ok(await page.locator('.dpm-area').count() >= 5, 'stacked component areas drawn');
  assert.ok(await page.locator('.dpm-life').count() >= 1 && await page.locator('.dpm-blip').count() >= 1, 'program lifetimes drawn: bars for long ones, ticks for short');

  // The table separates DSH from the programs it started, keeps ended ones, and opens any row in the side sheet.
  await page.locator('.dpm-name', { hasText: 'Python' }).waitFor();
  await page.getByRole('button', { name: /已退出/ }).click();
  assert.ok(await page.locator('tr[data-ended]').count() >= 1, 'ended programs listed');
  await page.getByRole('button', { name: /^CPU/ }).click();
  assert.equal(await page.locator('th[aria-sort="descending"]').innerText(), 'CPU');

  await page.locator('.dpm-scroll').evaluate(el => { el.scrollTop = 0; });
  await page.mouse.move(0, 0);
  await page.screenshot({ animations: 'disabled', path: 'artifacts/light-top.png' });
  // Pointing at a component anywhere lifts it in every chart.
  await page.locator('.dpm-keys li', { hasText: '工具进程' }).hover();
  assert.equal(await page.locator('.dpm-root').getAttribute('data-focus'), 'tools');
  await page.screenshot({ animations: 'disabled', path: 'artifacts/focus.png', clip: { x: 300, y: 50, width: 1120, height: 600 } });
  const canvas = await page.locator('.dpm-canvas').boundingBox();
  await page.mouse.move(canvas!.x + canvas!.width * .62, canvas!.y + 70);
  await page.locator('.dpm-tip').waitFor();
  assert.match(await page.locator('.dpm-tip').innerText(), /DSH 合计[\s\S]*整机/);
  await page.screenshot({ animations: 'disabled', path: 'artifacts/light.png', fullPage: false });
  await page.locator('.dpm-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.mouse.move(0, 0);
  await page.screenshot({ animations: 'disabled', path: 'artifacts/light-bottom.png' });
  await page.locator('.dpm-scroll').evaluate(el => { el.scrollTop = 0; });

  await page.locator('.dpm-name', { hasText: 'Python' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.waitFor(); assert.match(await sheet.innerText(), /命令行[\s\S]*mcp_server_git/);
  await page.clock.runFor(500);
  await page.screenshot({ animations: 'disabled', path: 'artifacts/sheet.png' });
  await page.keyboard.press('Escape'); await page.clock.runFor(500); await sheet.waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: '统计口径' }).click(); await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape'); await page.clock.runFor(500); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '1 小时', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '1 小时', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '15 分钟', exact: true }).click();

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('.dpm-scroll').evaluate(el => { el.scrollTop = 0; });
  await page.clock.runFor(300);
  await page.screenshot({ animations: 'disabled', path: 'artifacts/dark.png' });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  await page.getByRole('button', { name: '切换侧栏' }).click();
  assert.equal(await page.locator('.dpm-entry.dpm-compact').count(), 1);
  await page.setViewportSize({ width: 560, height: 1000 }); await page.clock.runFor(300);
  await page.locator('.dpm-scroll').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ animations: 'disabled', path: 'artifacts/narrow.png', fullPage: false });
  assert.equal(await page.locator('.dpm-scroll').evaluate(el => el.scrollWidth > el.clientWidth), false, 'no sideways scrolling at narrow width');
  assert.deepEqual(errors, []);
  const report = { errors, pageLazyLoaded: true, entrySelectedState: true, machineShare: true, linkedTracks: true, programMarks: true, endedPrograms: true,
    sideSheet: true, sorting: true, visibilityPause: true, errorAndRetry: true, collapsedSidebar: true, narrowOverflow: false, taskProbe, statisticsProbe,
    data: 'scripted collector readings; actual built client; real Chromium long frames and a real slow click; accelerated clock for the trend' };
  await writeFile('artifacts/browser-check.json', JSON.stringify(report, null, 2)); console.log(report);
} finally { await browser.close(); }
