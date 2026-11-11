const { spawn } = require('node:child_process');

const MAX_PREVIEW_BYTES = 256 * 144 * 4 + 8;

// PrintWindow 无法取消；只在短命子进程中调用，超时不会卡住主进程或来源注册表。
function captureWindowThumbnail(executablePath, target, { spawnProcess = spawn, timeoutMs = 1200 } = {}) {
  const child = spawnProcess(executablePath, ['--window-thumbnail'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let failure;
  const promise = new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    const fail = code => { failure ??= new Error(code); child.kill(); };
    const timer = setTimeout(() => fail('thumbnailTimeout'), timeoutMs);
    child.stdout.on('data', chunk => {
      byteLength += chunk.length;
      if (byteLength > MAX_PREVIEW_BYTES) fail('thumbnailOutputInvalid');
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => { failure ??= new Error('thumbnailInputFailed'); });
    child.once('error', () => { failure ??= new Error('thumbnailWorkerFailed'); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) { reject(failure ?? new Error('thumbnailCaptureFailed')); return; }
      const bitmap = Buffer.concat(chunks);
      if (bitmap.length < 8) { reject(new Error('thumbnailOutputInvalid')); return; }
      const width = bitmap.readUInt32LE(0), height = bitmap.readUInt32LE(4);
      if (!width || width > 256 || !height || height > 144 || bitmap.length !== 8 + width * height * 4) {
        reject(new Error('thumbnailOutputInvalid')); return;
      }
      resolve({ width, height, bitmap: bitmap.subarray(8) });
    });
    child.stdin.end(JSON.stringify(target));
  });
  return { promise, cancel: () => { failure ??= new Error('thumbnailCancelled'); child.kill(); } };
}

function createWindowThumbnailLoader({ executablePath, inspectSource, encode,
  onTiming = () => {}, capture = captureWindowThumbnail, now = Date.now }) {
  let owner, disposed = false;
  const cache = new Map(), pending = new Map(), queue = [], active = new Set();
  const sameSource = (entry, source) => entry && entry.title === source.title && entry.windowId === source.windowId;
  function reset() {
    cache.clear(); pending.clear();
    for (const job of queue.splice(0)) job.resolve([]);
    for (const job of active) job.worker?.cancel();
  }
  function pump() {
    while (!disposed && active.size < 2 && queue.length) {
      const job = queue.shift();
      active.add(job);
      void run(job).finally(() => {
        active.delete(job);
        if (pending.get(job.source.sourceId) === job) pending.delete(job.source.sourceId);
        pump();
      });
    }
  }
  async function run(job) {
    const started = now();
    const current = () => !disposed && owner === job.owner;
    let result = [], outcome = 'failed';
    try {
      const target = await inspectSource(job.source.sourceId);
      if (!current()) return;
      job.worker = capture(executablePath(), target);
      const image = await job.worker.promise;
      if (!current()) return;
      const thumbnail = encode(image);
      if (typeof thumbnail !== 'string' || !/^data:image\/jpeg;base64,/.test(thumbnail)
          || Buffer.byteLength(thumbnail) > 64 * 1024) throw new Error('thumbnailOutputInvalid');
      result = [{ sourceId: job.source.sourceId, thumbnail }]; outcome = 'ready';
    } catch (error) {
      outcome = error.message === 'thumbnailTimeout' ? 'timeout' : 'failed';
    } finally {
      if (current()) {
        const previous = cache.get(job.source.sourceId);
        const failures = result.length ? 0 : (sameSource(previous, job.source) ? previous.failures : 0) + 1;
        cache.delete(job.source.sourceId);
        cache.set(job.source.sourceId, { ...job.source, result, failures, createdAt: now() });
        while (cache.size > 24) cache.delete(cache.keys().next().value);
        onTiming({ stage: 'sourceWindowThumbnail', durationMs: now() - started, outcome, sourceCount: 1 });
      }
      job.resolve(current() ? result : []);
    }
  }
  function load(state, source) {
    if (disposed) return Promise.resolve([]);
    if (owner !== state) { reset(); owner = state; }
    const previous = cache.get(source.sourceId);
    const cached = sameSource(previous, source) && now() - previous.createdAt < 60_000 ? previous.result : [];
    // 首次空图尽快重试；持续失败逐步退避，避免对不支持截图的应用不断创建进程。
    const retryMs = previous?.result.length ? 10_000 : [1500, 5000, 15_000][Math.min((previous?.failures ?? 1) - 1, 2)];
    if (sameSource(previous, source) && now() - previous.createdAt < retryMs) {
      return Promise.resolve(previous.result);
    }
    let job = pending.get(source.sourceId);
    if (job && !sameSource(job.source, source)) {
      // 同一窗口改名时不使用旧快照；现有任务结束后由选择器再次请求。
      return Promise.resolve([]);
    }
    if (!job) {
      if (pending.size >= 32) return Promise.resolve(cached);
      job = { owner: state, source };
      job.promise = new Promise(resolve => { job.resolve = resolve; });
      pending.set(source.sourceId, job); queue.push(job); pump();
    }
    return cached.length ? Promise.resolve(cached) : job.promise;
  }
  return { load, dispose() { disposed = true; reset(); } };
}

module.exports = { captureWindowThumbnail, createWindowThumbnailLoader };
