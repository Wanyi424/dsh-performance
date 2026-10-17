import { build, transform } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
await mkdir('lib', { recursive: true }); await mkdir('dist', { recursive: true });
const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', `/out:${resolve('lib/collector.exe')}`, resolve('native/Collector.cs')], { stdio: 'inherit', windowsHide: true });
// Stylesheets are authored readable and shipped minified as text injected by the page.
const cssText = { name: 'css-text', setup(plugin) {
  plugin.onLoad({ filter: /\.css$/ }, async args => ({ loader: 'text', contents: (await transform(await readFile(args.path, 'utf8'), { loader: 'css', minify: true, target: 'chrome130' })).code }));
} };
await build({ entryPoints: ['src/host.ts'], outfile: 'lib/host.js', bundle: true, platform: 'node', target: 'node22', format: 'esm' });
await Promise.all([['src/client.tsx', 'client.js'], ['src/page.tsx', 'client.page.js']].map(([entry, file]) => build({
  entryPoints: [entry], outfile: `lib/${file}`, bundle: true, platform: 'browser', target: 'chrome130', format: 'cjs', jsx: 'transform', minify: true,
  external: ['react', 'react/jsx-runtime', 'react-dom'], plugins: [cssText],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(file === 'client.js' ? 'dsh-performance' : 'dsh-performance/' + file)}, factory(require) { const module = { exports: {} }; const exports = module.exports;` },
  footer: { js: 'return module.exports; } });' }, define: { 'process.env.NODE_ENV': '"production"' },
})));
console.log('Built Windows collector, Host, sidebar entry and lazy details page.');
