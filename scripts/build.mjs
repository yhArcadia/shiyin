import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
await mkdir(out, { recursive: true });
for (const entry of ['index.html', 'credits.html', 'src', 'assets', 'third-party']) await cp(resolve(root, entry), resolve(out, entry), { recursive: true });
await mkdir(resolve(out, 'vendor'), { recursive: true });
await cp(resolve(root, 'node_modules/@ffmpeg/ffmpeg/dist/esm'), resolve(out, 'vendor/ffmpeg'), { recursive: true });
await mkdir(resolve(out, 'vendor/core'), { recursive: true });
await cp(resolve(root, 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js'), resolve(out, 'vendor/core/ffmpeg-core.js'));
const wasm = await readFile(resolve(root, 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm'));
const chunks = [];
const chunkSize = 1024 * 1024;
for (let i = 0; i * chunkSize < wasm.length; i++) {
  const filename = `ffmpeg-core-1m-${i}.bin`;
  const part = wasm.subarray(i * chunkSize, (i + 1) * chunkSize);
  await writeFile(resolve(out, 'vendor/core', filename), part);
  chunks.push({ name: filename, bytes: part.byteLength });
}
await writeFile(resolve(out, 'vendor/core/manifest.json'), JSON.stringify({ version: '0.12.10', bytes: wasm.length, chunks }));
await mkdir(resolve(out, 'vendor/fflate'), { recursive: true });
await cp(resolve(root, 'node_modules/fflate/esm/browser.js'), resolve(out, 'vendor/fflate/browser.js'));
await cp(resolve(root, 'node_modules/lucide/dist/umd/lucide.min.js'), resolve(out, 'vendor/lucide.min.js'));
for (const [name, folder] of [['ffmpeg', '@ffmpeg/ffmpeg'], ['core', '@ffmpeg/core'], ['fflate', 'fflate'], ['lucide', 'lucide']]) {
  for (const file of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) {
    const path = resolve(root, 'node_modules', folder, file);
    try { await access(path); await cp(path, resolve(out, `vendor/${name}-LICENSE.txt`)); break; } catch {}
  }
}
await writeFile(resolve(out, '.nojekyll'), '');
console.log(`Built ${out}; audio engine ${Math.round(wasm.length / 1024 / 1024)} MB, ${chunks.length} local chunks.`);
