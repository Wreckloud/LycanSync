const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { win32 } = require('node:path');

function normalizeActivity(value) {
  if (value?.activityType == null) return null;
  if (!['GAME', 'MUSIC'].includes(value.activityType) || typeof value.activityName !== 'string'
      || !Number.isSafeInteger(value.startedAtEpochSeconds)) return undefined;
  const name = value.activityName.replace(/\s+/g, ' ').trim();
  const startedAt = value.startedAtEpochSeconds * 1000;
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)
      || startedAt <= 0 || startedAt > Date.now() + 60_000) return undefined;
  return { type: value.activityType, name, startedAt: new Date(startedAt).toISOString() };
}

function validExecutable(value) {
  return typeof value === 'string' && value.length <= 4096 && win32.isAbsolute(value)
    && value.toLowerCase().endsWith('.exe') && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeMappings(value) {
  if (!Array.isArray(value) || value.length > 32) throw new Error('最多记忆 32 个动态程序。');
  const seen = new Set();
  return value.map((entry) => {
    if (!validExecutable(entry?.executable) || typeof entry.name !== 'string'
        || !entry.name.trim() || entry.name.length > 80 || /[\u0000-\u001f\u007f]/.test(entry.name)) {
      throw new Error('动态名称设置无效，请重新选择程序。');
    }
    const executable = entry.executable.replaceAll('/', '\\').toLowerCase();
    if (seen.has(executable)) throw new Error('不能重复添加同一个动态程序。');
    seen.add(executable);
    return { executable, name: entry.name.trim() };
  });
}

function createActivityHelper({ enabled, executablePath, onActivity, spawnProcess = spawn,
  openLines = createInterface, fileExists = existsSync, schedule = setTimeout, cancel = clearTimeout }) {
  let child;
  let stopped = true;
  let restarting;
  let sequence = 0;
  let configurationId = 0;
  let mappings = [];
  let current = null;
  const pending = new Map();

  function publish(activity) {
    if (JSON.stringify(current) === JSON.stringify(activity)) return;
    current = activity;
    onActivity(activity);
  }

  function request(method, parameters = {}) {
    if (!child || pending.size >= 8) return Promise.reject(new Error('动态检测暂不可用，请稍后重试。'));
    const target = child;
    const requestId = ++sequence;
    const promise = new Promise((resolve, reject) => {
      const timeout = schedule(() => {
        pending.delete(requestId);
        reject(new Error('动态检测响应超时，请重试。'));
        // 不再接受超时配置稍后产生的活动；退出回调会重建唯一 helper。
        target.kill();
      }, 10_000);
      pending.set(requestId, { resolve, reject, timeout });
      target.stdin.write(`${JSON.stringify({ method, requestId, ...parameters })}\n`, (error) => {
        if (!error) return;
        const entry = pending.get(requestId);
        if (!entry) return;
        cancel(entry.timeout);
        pending.delete(requestId);
        reject(new Error('无法更新动态检测，请重试。'));
        target.kill();
      });
    });
    if (method === 'configure') {
      configurationId = requestId;
      publish(null);
    }
    return promise;
  }

  function start() {
    if (!enabled || child) return;
    stopped = false;
    if (!fileExists(executablePath())) return;
    const target = spawnProcess(executablePath(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child = target;
    const reader = openLines({ input: target.stdout, crlfDelay: Infinity });
    let finished = false;
    const finish = () => {
      if (finished || child !== target) return;
      finished = true;
      child = undefined;
      reader.close();
      publish(null);
      for (const entry of pending.values()) {
        cancel(entry.timeout);
        entry.reject(new Error('动态检测已停止，请重试。'));
      }
      pending.clear();
      if (!stopped) restarting = schedule(start, 5000);
    };
    reader.on('line', (line) => {
      if (finished || stopped || child !== target || line.length > 1024 * 1024) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (Number.isSafeInteger(message?.requestId)) {
        const entry = pending.get(message.requestId);
        if (!entry) return;
        cancel(entry.timeout);
        pending.delete(message.requestId);
        if (message.error) entry.reject(new Error(String(message.error).slice(0, 120)));
        else entry.resolve(message);
        return;
      }
      // 配置序号和进程身份一起隔离账号切换、重启与旧命令的迟到输出。
      if (message?.configurationId !== configurationId) return;
      const activity = normalizeActivity(message);
      if (activity !== undefined) publish(activity);
    });
    target.stdin.on('error', finish);
    target.once('error', finish);
    target.once('exit', finish);
    void request('configure', { mappings }).catch(() => {});
  }

  function stop() {
    stopped = true;
    cancel(restarting);
    restarting = undefined;
    const target = child;
    child = undefined;
    target?.kill();
    for (const entry of pending.values()) {
      cancel(entry.timeout);
      entry.reject(new Error('动态检测已停止。'));
    }
    pending.clear();
    publish(null);
  }

  async function configure(value) {
    const next = normalizeMappings(value);
    if (!enabled) throw new Error('动态检测仅支持 Windows 桌面版。');
    start();
    const previous = mappings;
    mappings = next;
    const configuring = request('configure', { mappings: next });
    const revision = configurationId;
    try {
      await configuring;
      if (revision !== configurationId) throw new Error('动态名称设置已被新的操作替换。');
    } catch (error) {
      if (revision === configurationId) {
        mappings = previous;
        publish(null);
        child?.kill();
      }
      throw error;
    }
  }

  async function listWindows() {
    if (!enabled) throw new Error('窗口选择仅支持 Windows 桌面版。');
    start();
    const response = await request('windows');
    if (!Array.isArray(response.windows) || response.windows.length > 128
        || response.windows.some((entry) => !validExecutable(entry?.executable)
          || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 80
          || /[\u0000-\u001f\u007f]/.test(entry.title))) {
      throw new Error('窗口列表无效，请刷新重试。');
    }
    return response.windows.map(({ executable, title }) => ({ executable, title }));
  }

  function clearMappings() {
    mappings = [];
    configurationId = ++sequence;
    publish(null);
    if (child) {
      const target = child;
      const clearing = request('configure', { mappings });
      const revision = configurationId;
      void clearing.catch(() => { if (child === target && configurationId === revision) target.kill(); });
    }
  }

  async function isCaptureGame(executable) {
    if (!enabled || !validExecutable(executable)) throw new Error('obsCaptureGameDetectionFailed');
    start();
    const revision = configurationId;
    const target = child;
    try {
      const response = await request('captureGame', { executable });
      if (child !== target || stopped || revision !== configurationId || typeof response.game !== 'boolean') {
        throw new Error('obsCaptureGameDetectionFailed');
      }
      return response.game;
    } catch {
      throw new Error('obsCaptureGameDetectionFailed');
    }
  }

  return { start, stop, configure, listWindows, clearMappings, isCaptureGame };
}

module.exports = { createActivityHelper, normalizeActivity, normalizeMappings };
