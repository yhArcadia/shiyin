import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadPart, prepareEngineFiles, waitForTask, PreparationError } from '../src/engine-loader.mjs';

test('收到第一批数据就更新进度，不等待整个文件下载完', async () => {
  let stream, report, complete = false;
  const firstProgress = new Promise(resolve => { report = resolve; });
  const progress = [];
  const task = downloadPart('https://test.invalid/part.bin', {
    expectedBytes: 6,
    fetcher: async () => new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new Uint8Array([0, 97, 115, 109])); } })),
    onBytes: bytes => { progress.push(bytes); report(); }
  }).then(blob => { complete = true; return blob; });
  await firstProgress;
  assert.equal(complete, false);
  assert.deepEqual(progress, [4]);
  stream.enqueue(new Uint8Array([1, 0])); stream.close();
  assert.equal((await task).size, 6);
  assert.deepEqual(progress, [4, 6]);
});

test('连接一直不返回时主动退出，实际请求也收到取消', async () => {
  let signal;
  await assert.rejects(downloadPart('https://test.invalid/part.bin', {
    idleMs: 15, maxMs: 150,
    fetcher: (_url, options) => { signal = options.signal; return new Promise(() => {}); }
  }), error => error instanceof PreparationError && error.stage === 'download');
  assert.equal(signal.aborted, true);
});

test('响应中途停住会退出，不会一直停在原进度', async () => {
  let canceled = false;
  await assert.rejects(downloadPart('https://test.invalid/part.bin', {
    expectedBytes: 6, idleMs: 15, maxMs: 150,
    fetcher: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0, 97])); }, cancel() { canceled = true; } }))
  }), error => error instanceof PreparationError && error.stage === 'download');
  assert.equal(canceled, true);
});

test('用户取消可立即结束不响应的读取', async () => {
  const controller = new AbortController();
  const task = downloadPart('https://test.invalid/part.bin', {
    signal: controller.signal,
    fetcher: async () => new Response(new ReadableStream())
  });
  controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
});

test('动态模块或浏览器操作不响应时也有超时和取消边界', async () => {
  await assert.rejects(waitForTask(() => new Promise(() => {}), { timeoutMs: 10, stage: 'module' }), error => error.stage === 'module');
  const controller = new AbortController();
  const task = waitForTask(() => new Promise(() => {}), { signal: controller.signal });
  controller.abort();
  await assert.rejects(task, { name: 'AbortError' });
});

test('失败重试复用已完成分片，按原顺序拼装核心文件', async () => {
  const first = new Uint8Array([0, 97, 115, 109]), second = new Uint8Array([1, 2, 3]);
  const manifest = { bytes: 7, chunks: [{ name: 'a.bin', bytes: 4 }, { name: 'b.bin', bytes: 3 }] };
  const cached = new Map(), calls = { a: 0, b: 0 };
  let releaseFirst, fail = true;
  const firstSaved = new Promise(resolve => { releaseFirst = resolve; });
  const cacheStorage = { open: async () => ({
    match: async url => cached.get(url)?.clone(),
    put: async (url, response) => { cached.set(url, response); if (url.endsWith('/a.bin')) releaseFirst(); }
  }) };
  const fetcher = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/manifest.json')) return Response.json(manifest);
    if (path.endsWith('/a.bin')) { calls.a++; return new Response(first); }
    calls.b++; await firstSaved;
    if (fail) throw new TypeError('network disconnected');
    return new Response(second);
  };
  const options = { fetcher, cacheStorage, onUpdate() {} };
  await assert.rejects(prepareEngineFiles(new URL('https://test.invalid/core/'), options), /network disconnected/);
  fail = false;
  const result = await prepareEngineFiles(new URL('https://test.invalid/core/'), options);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([...first, ...second]));
  assert.deepEqual(calls, { a: 1, b: 3 });
});

test('缓存被浏览器禁用时仍可完成准备，并拒绝截断文件', async () => {
  const updates = [];
  const blob = await prepareEngineFiles(new URL('https://test.invalid/core/'), {
    cacheStorage: { open: async () => { throw new Error('storage unavailable'); } },
    onUpdate: event => updates.push(event),
    fetcher: async url => new URL(url).pathname.endsWith('.json')
      ? Response.json({ bytes: 4, chunks: [{ name: 'a.bin', bytes: 4 }] })
      : new Response(new Uint8Array([0, 97, 115, 109]))
  });
  assert.equal(blob.size, 4);
  assert.ok(updates.some(event => event.detail?.includes('MB')));
  await assert.rejects(downloadPart('https://test.invalid/a.bin', { expectedBytes: 10, fetcher: async () => new Response('short') }), PreparationError);
});
