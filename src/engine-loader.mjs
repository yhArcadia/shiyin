const abortError = () => new DOMException('已取消', 'AbortError');
const ensureActive = signal => { if (signal?.aborted) throw abortError(); };
const CACHE_NAME = 'shiyin-audio-core-v2';
const isWasmStart = async blob => new Uint8Array(await blob.slice(0, 4).arrayBuffer()).join(',') === '0,97,115,109';

export class PreparationError extends Error {
  constructor(message, stage) { super(message); this.name = 'PreparationError'; this.userMessage = message; this.stage = stage; }
}

// A deadline must reject even when an import, browser cache or reader ignores abort.
export async function waitForTask(task, { signal, timeoutMs = 20000, message = '音频工具连接超时，请切换网络后重试。', stage = 'connection', onTimeout } = {}) {
  ensureActive(signal);
  let timer, abort;
  const boundary = new Promise((_, reject) => {
    abort = () => reject(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { reject(new PreparationError(message, stage)); onTimeout?.(); }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(task), boundary]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function downloadPart(url, { signal, expectedBytes, onBytes = () => {}, fetcher = fetch, idleMs = 20000, maxMs = 90000 } = {}) {
  ensureActive(signal);
  const request = new AbortController();
  const abort = () => request.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let reader, idleTimer, rejectIdle;
  const stalled = new Promise((_, reject) => { rejectIdle = reject; });
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      rejectIdle(new PreparationError('音频工具下载中断了，请切换网络后重试。已完成的工具文件可继续复用。', 'download'));
      request.abort();
    }, idleMs);
  };
  resetIdle();
  const operation = async () => {
    const response = await fetcher(url, { signal: request.signal });
    if (!response.ok) throw new PreparationError(`暂时无法下载音频工具（HTTP ${response.status}），请稍后重试。`, 'download');
    resetIdle();
    let blob, received = 0;
    if (response.body?.getReader) {
      reader = response.body.getReader();
      const pieces = [];
      while (true) {
        ensureActive(request.signal);
        const { done, value } = await reader.read();
        ensureActive(request.signal);
        if (done) break;
        received += value.byteLength;
        if (expectedBytes && received > expectedBytes) throw new PreparationError('音频工具文件不完整，请重试。', 'download');
        pieces.push(value); onBytes(received); resetIdle();
      }
      blob = new Blob(pieces, { type: 'application/octet-stream' });
    } else {
      blob = await response.blob(); ensureActive(request.signal); onBytes(blob.size);
    }
    if (!blob.size || (expectedBytes && blob.size !== expectedBytes)) throw new PreparationError('音频工具文件不完整，请重试。', 'download');
    return blob;
  };
  try {
    return await waitForTask(() => Promise.race([operation(), stalled]), {
      signal, timeoutMs: maxMs, stage: 'download', onTimeout: abort,
      message: '这次音频工具下载太慢了，请切换网络后重试。已完成的工具文件可继续复用。'
    });
  } finally {
    clearTimeout(idleTimer); signal?.removeEventListener('abort', abort);
    request.abort(); reader?.cancel().catch(() => {});
  }
}

export async function prepareEngineFiles(base, { signal, onUpdate, fetcher = fetch, cacheStorage = globalThis.caches } = {}) {
  onUpdate({ phase: 'loading', progress: null, message: '正在连接音频工具的下载地址…', detail: '视频仍在本机，不会上传' });
  const manifestRequest = new AbortController();
  const manifestAbort = () => manifestRequest.abort();
  signal?.addEventListener('abort', manifestAbort, { once: true });
  let manifest;
  try {
    manifest = await waitForTask(async () => {
      const response = await fetcher(new URL('manifest.json?v=2', base), { signal: manifestRequest.signal });
      if (!response.ok) throw new PreparationError('暂时无法连接音频工具的下载地址，请切换网络后重试。', 'manifest');
      return response.json();
    }, { signal, stage: 'manifest', onTimeout: manifestAbort });
  } finally { signal?.removeEventListener('abort', manifestAbort); manifestRequest.abort(); }
  if (!manifest || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 || !Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.some(part => !/^[\w.-]+\.bin$/.test(part.name) || !Number.isSafeInteger(part.bytes) || part.bytes <= 0) || manifest.chunks.reduce((sum, part) => sum + part.bytes, 0) !== manifest.bytes) {
    throw new PreparationError('音频工具版本没有加载完整，请刷新页面后重试。', 'manifest');
  }
  let cache = null;
  if (cacheStorage) {
    try { cache = await waitForTask(() => cacheStorage.open(CACHE_NAME), { signal, timeoutMs: 1200 }); }
    catch (error) { ensureActive(signal); }
  }
  const loaded = new Array(manifest.chunks.length).fill(0), parts = new Array(manifest.chunks.length);
  let cachedBytes = 0, lastPaint = 0;
  const report = (force = false, retry = false) => {
    if (!force && Date.now() - lastPaint < 100) return;
    lastPaint = Date.now();
    const received = loaded.reduce((sum, value) => sum + value, 0), mb = n => (n / 1024 / 1024).toFixed(1);
    onUpdate({ phase: 'loading', progress: 0.03 + received / manifest.bytes * 0.87,
      message: retry ? '连接有点慢，正在重新连接…' : '正在下载音频工具，完成后会自动开始导出。',
      detail: `${mb(received)} / ${mb(manifest.bytes)} MB${cachedBytes ? ` · 已复用 ${mb(cachedBytes)} MB` : ''}，请保持页面在前台` });
  };
  let next = 0;
  const group = new AbortController();
  const groupAbort = () => group.abort();
  signal?.addEventListener('abort', groupAbort, { once: true });
  async function worker() {
    while (next < manifest.chunks.length) {
      ensureActive(group.signal);
      const index = next++, part = manifest.chunks[index], url = new URL(part.name, base).href;
      let blob;
      if (cache) {
        try {
          blob = await waitForTask(async () => { const stored = await cache.match(url); return stored?.blob(); }, { signal: group.signal, timeoutMs: 1200 });
          if (blob?.size !== part.bytes) blob = null;
          if (blob && index === 0 && !await isWasmStart(blob)) blob = null;
          if (blob) { cachedBytes += blob.size; loaded[index] = blob.size; report(true); }
        } catch { ensureActive(group.signal); }
      }
      if (!blob) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            blob = await downloadPart(url, { signal: group.signal, expectedBytes: part.bytes, fetcher,
              onBytes: bytes => { loaded[index] = bytes; report(); } });
            if (index === 0 && !await isWasmStart(blob)) throw new PreparationError('下载的音频工具文件不正确，请切换网络后重试。', 'download');
            break;
          } catch (error) {
            ensureActive(group.signal);
            loaded[index] = 0;
            if (attempt === 1) throw error;
            report(true, true);
          }
        }
        if (cache) {
          try { await waitForTask(() => cache.put(url, new Response(blob)), { signal: group.signal, timeoutMs: 1200 }); }
          catch { ensureActive(group.signal); }
        }
      }
      parts[index] = blob; loaded[index] = part.bytes; report(true);
    }
  }
  try {
    report(true);
    await Promise.all([worker(), worker()]);
    ensureActive(group.signal);
    return new Blob(parts, { type: 'application/wasm' });
  } finally { group.abort(); signal?.removeEventListener('abort', groupAbort); }
}
