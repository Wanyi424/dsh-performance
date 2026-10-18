import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
// The check is about the collector built from this source; an older build would answer for older code.
if ((await stat('lib/collector.exe')).mtimeMs < (await stat('native/Collector.cs')).mtimeMs) throw new Error('lib/collector.exe 早于 native/Collector.cs，请先运行 npm run build。');
const root = await mkdtemp(join(tmpdir(), 'dsh-performance-check-'));
let external: ChildProcess | undefined;
try {
  const executable = join(root, 'DeepSeek Harness.exe');
  execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/optimize+', `/out:${executable}`, resolve('tests/DesktopFixture.cs')], { windowsHide: true });
  // Same name and path as the fixture desktop, but not in its tree: it must not be counted.
  external = spawn(executable, ['--child'], { windowsHide: true, stdio: 'ignore' });
  const { stdout } = await promisify(execFile)(executable, [process.execPath, resolve('scripts/native-fixture.ts'), resolve('lib/collector.exe'), String(external.pid)], { windowsHide: true, timeout: 40_000 });
  const report = JSON.parse(stdout.trim());
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/collector-check.json', JSON.stringify(report, null, 2)); console.log(report);
} finally {
  if (external && external.exitCode === null) { external.kill(); await once(external, 'exit'); }
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('dsh-performance-check-'));
  await rm(root, { recursive: true, force: true });
}
