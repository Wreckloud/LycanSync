const { randomUUID } = require('node:crypto');
const { win32 } = require('node:path');

function leagueCaptureApplication(executable) {
  if (typeof executable !== 'string' || !win32.isAbsolute(executable)) return null;
  const path = win32.normalize(executable).toLowerCase();
  const name = win32.basename(path);
  if (name === 'leagueclient.exe' || name === 'leagueclientux.exe') {
    return { root: win32.dirname(path), phase: 'lobby' };
  }
  if (name === 'league of legends.exe' && win32.basename(win32.dirname(path)) === 'game') {
    return { root: win32.dirname(win32.dirname(path)), phase: 'match' };
  }
  return null;
}

function sameWindow(left, right) {
  return left?.windowId === right.windowId && left?.lifetimeName === right.lifetimeName
    && left?.processId === right.processId && left?.processCreationTime === right.processCreationTime;
}

// 只授权一次选中的英雄联盟安装目录；实例切换仍由原生身份校验与正常启停完成。
function createLeagueCaptureFollow({ listSources, inspectSource, discoveryState, createId = randomUUID }) {
  let current;

  function requireFollow(id) {
    if (!current || current.id !== id || current.state !== discoveryState()
        || !current.state.alive || current.state.closed) throw new Error('nativeGameFollowUnavailable');
    return current;
  }

  function bind(id, sourceId, target) {
    const follow = requireFollow(id);
    const application = target.kind === 'window' && leagueCaptureApplication(target.executable);
    if (!application || application.root !== follow.root) throw new Error('nativeGameFollowTargetInvalid');
    follow.sourceId = sourceId;
    follow.target = target;
  }

  return {
    begin(sourceId, target) {
      const application = target.kind === 'window' && leagueCaptureApplication(target.executable);
      const state = discoveryState();
      if (!application || !state?.alive || state.closed) throw new Error('nativeGameFollowTargetInvalid');
      current = { id: createId(), root: application.root, state, sourceId, target, cache: new Map() };
      return current.id;
    },
    bind,
    require: requireFollow,
    end(id) {
      if (current?.id !== id) return;
      current.cancelled = true;
      current = undefined;
    },
    async findSource(id) {
      const follow = requireFollow(id);
      if (follow.finding) return follow.finding;
      follow.finding = (async () => {
        let currentLive = false;
        try { currentLive = sameWindow(follow.target, await inspectSource(follow.sourceId)); }
        catch { /* 来源结束由原启停流程确认；可选列表缺失本身不能证明结束。 */ }
        const snapshot = await listSources();
        if (requireFollow(id) !== follow) throw new Error('nativeGameFollowUnavailable');
        const windows = snapshot.sources.filter(source => source.kind === 'window');
        const ids = new Set(windows.map(source => source.sourceId));
        for (const key of follow.cache.keys()) if (!ids.has(key)) follow.cache.delete(key);
        await Promise.all(windows.filter(source => !follow.cache.has(source.sourceId)).map(async source => {
          let candidate = null;
          try {
            const target = await inspectSource(source.sourceId);
            const application = target.kind === 'window' && leagueCaptureApplication(target.executable);
            if (application?.root === follow.root) candidate = { sourceId: source.sourceId, target, phase: application.phase };
          } catch { return; } // 未确认身份不补匹配，也不把暂时不可读永久缓存为非游戏。
          if (current === follow) follow.cache.set(source.sourceId, candidate);
        }));
        if (requireFollow(id) !== follow) throw new Error('nativeGameFollowUnavailable');
        const candidates = [...follow.cache.values()].filter(Boolean);
        const matches = candidates.filter(candidate => candidate.phase === 'match');
        if (currentLive && (leagueCaptureApplication(follow.target.executable)?.phase === 'match' || !matches.length)) {
          return { sourceId: follow.sourceId };
        }
        const preferred = matches.length ? matches : candidates;
        const existing = preferred.find(candidate => sameWindow(follow.target, candidate.target));
        if (existing) return { sourceId: follow.sourceId };
        if (preferred.length > 1) throw new Error('nativeGameFollowTargetAmbiguous');
        return { sourceId: preferred[0]?.sourceId ?? null };
      })().catch(error => {
        if (follow.cancelled) throw new Error('nativeGameFollowCancelled');
        throw error;
      }).finally(() => { follow.finding = undefined; });
      return follow.finding;
    },
  };
}

module.exports = { leagueCaptureApplication, createLeagueCaptureFollow };
