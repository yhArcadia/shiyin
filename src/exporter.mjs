import { prepareEngineFiles, waitForTask } from './engine-loader.mjs';

let engine = null;
let controller = null;
let zipWorker = null;
let canceled = false;
let progressCallback = null;
let currentDuration = 1;
let logs = [];

export function cancelExport() {
  canceled = true;
  controller?.abort();
  engine?.terminate();
  engine = null;
  zipWorker?.terminate();
  zipWorker = null;
}
function checkCanceled() { if (canceled) throw new DOMException('已取消', 'AbortError'); }
function friendlyError(error) {
  if (canceled || error?.name === 'AbortError') return new Error('已取消导出，你的分段和名称都保留着。');
  if (error?.userMessage) return new Error(error.userMessage);
  const detail = `${String(error)}\n${logs.join('\n')}`;
  if (/matches no streams|does not contain any stream|Stream map.*matches/i.test(detail)) return new Error('这个视频没有可读取的声音。可以换一个带声音的视频再试。');
  if (/out of memory|memory access|allocation|Array buffer|Cannot enlarge memory/i.test(detail)) return new Error('浏览器的可用内存不够了。请关闭一些标签页，或换一个小一点的视频再试。');
  if (/fetch|network|load|HTTP|worker|compile|timeout/i.test(detail)) return new Error('音频工具暂时没有准备好。请检查网络后重试，你的编辑内容还在。');
  return new Error('这一段暂时没能导出。可以重试，或换一个常见的 MP4 视频再试。');
}
async function loadEngine(onUpdate) {
  if (engine?.loaded) return engine;
  onUpdate({ phase: 'loading', progress: null, message: '正在连接音频工具…', detail: '首次需要下载约 31 MB，请保持页面在前台' });
  const { FFmpeg } = await waitForTask(() => import('../vendor/ffmpeg/index.js'), { signal: controller.signal, stage: 'module' });
  checkCanceled();
  const instance = new FFmpeg();
  engine = instance;
  instance.on('log', ({ message }) => { logs.push(message); if (logs.length > 35) logs.shift(); });
  instance.on('progress', ({ time }) => {
    if (progressCallback) progressCallback(Math.max(0, Math.min(0.98, time / 1_000_000 / currentDuration)));
  });
  const base = new URL('../vendor/core/', import.meta.url);
  const blob = await waitForTask(() => prepareEngineFiles(base, { signal: controller.signal, onUpdate }), {
    signal: controller.signal, timeoutMs: 8 * 60 * 1000, stage: 'download', onTimeout: () => controller.abort(),
    message: '当前网络下载音频工具太慢，请切换网络后重试。你的编辑和已完成的工具文件会保留。'
  });
  checkCanceled();
  onUpdate({ phase: 'loading', progress: 0.92, message: '文件已准备好，正在启动音频工具…', detail: '手机首次启动可能需要一些时间，请保持页面在前台' });
  const wasmURL = URL.createObjectURL(blob);
  try {
    await waitForTask(() => instance.load({ coreURL: new URL('ffmpeg-core.js', base).href, wasmURL }, { signal: controller.signal }), {
      signal: controller.signal, timeoutMs: 60000, stage: 'runtime',
      message: '文件已下载，但浏览器没能启动音频工具。请更新浏览器，或使用电脑浏览器打开同一网址重试。'
    });
  } finally { URL.revokeObjectURL(wasmURL); }
  checkCanceled();
  return instance;
}
async function makeArchive(files) {
  if (files.length === 1) return { blob: new Blob([files[0].bytes], { type: files[0].name.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' }), filename: files[0].name };
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./zip-worker.mjs', import.meta.url), { type: 'module' });
    zipWorker = worker;
    const abort = () => { worker.terminate(); reject(new DOMException('已取消', 'AbortError')); };
    controller.signal.addEventListener('abort', abort, { once: true });
    function cleanup() { controller.signal.removeEventListener('abort', abort); worker.terminate(); if (zipWorker === worker) zipWorker = null; }
    worker.onmessage = ({ data }) => { cleanup(); if (data.error) reject(new Error(data.error)); else resolve({ blob: new Blob([data.bytes], { type: 'application/zip' }), filename: '' }); };
    worker.onerror = error => { cleanup(); reject(error); };
    worker.postMessage({ files }, files.map(file => file.bytes.buffer));
  });
}
export async function exportClips({ file, clips, format, archiveName, onUpdate }) {
  canceled = false;
  controller = new AbortController();
  const results = [];
  let instance, mounted = false, copied = false, failure = null;
  logs = [];
  try {
    instance = await loadEngine(onUpdate);
    checkCanceled();
    onUpdate({ phase: 'reading', progress: 0, message: '正在读取视频里的声音…' });
    try { await instance.createDir('/source'); } catch {}
    let source;
    try {
      await instance.mount('WORKERFS', { files: [file] }, '/source');
      source = `/source/${file.name}`;
      mounted = true;
    } catch {
      checkCanceled();
      source = '/input-video';
      await instance.writeFile(source, new Uint8Array(await file.arrayBuffer()));
      copied = true;
    }
    for (let i = 0; i < clips.length; i++) {
      checkCanceled();
      const clip = clips[i];
      logs = [];
      currentDuration = clip.end - clip.start;
      const output = `/clip-${i}.${format}`;
      progressCallback = ratio => onUpdate({ phase: 'encoding', progress: (i + ratio) / clips.length, index: i + 1, total: clips.length, message: `正在导出第 ${i + 1} / ${clips.length} 段：${clip.filename}` });
      progressCallback(0);
      const codec = format === 'wav' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-b:a', '192k'];
      const args = ['-ss', clip.start.toFixed(3), '-i', source, '-t', (clip.end - clip.start).toFixed(3), '-map', '0:a:0', '-vn', '-map_metadata', '-1', ...codec, '-y', output];
      const code = await instance.exec(args);
      checkCanceled();
      if (code !== 0) throw new Error(`FFmpeg exited with ${code}`);
      const bytes = await instance.readFile(output);
      if (!bytes.byteLength) throw new Error('Empty output');
      results.push({ name: clip.filename, bytes, id: clip.id });
      await instance.deleteFile(output);
      progressCallback(1);
    }
  } catch (error) {
    failure = friendlyError(error);
    console.error('Audio export:', error, logs.join('\n'));
    if (engine && !canceled) { engine.terminate(); engine = null; }
  } finally {
    progressCallback = null;
    if (instance?.loaded && !canceled) {
      try { if (mounted) await instance.unmount('/source'); if (copied) await instance.deleteFile('/input-video'); } catch {}
    }
  }
  const completed = results.map(result => result.id);
  const remaining = clips.filter(clip => !completed.includes(clip.id)).map(clip => clip.id);
  if (canceled) return { canceled: true, error: failure?.message, completed, remaining, artifact: null };
  let artifact = null;
  if (results.length) {
    try {
      onUpdate({ phase: 'packing', progress: 1, message: results.length > 1 ? '音频已完成，正在放进压缩包…' : '音频已完成，正在准备保存…' });
      artifact = await makeArchive(results);
      artifact.filename ||= `${archiveName}.zip`;
    } catch (error) { failure = friendlyError(error); }
  }
  return { canceled, error: failure?.message || null, completed, remaining, artifact };
}
