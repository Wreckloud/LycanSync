const { randomUUID } = require('node:crypto');

const ACTIONS = ['microphone', 'listening', 'pushToTalk', 'replay'];
const WM_HOTKEY = 0x0312;

function parseBinding(value) {
  if (value === '') return null;
  if (typeof value !== 'string' || value.length > 40) throw new Error('快捷键格式无效');
  const parts = value.split('+');
  const key = parts.pop();
  const modifiers = ['Ctrl', 'Alt', 'Shift'].filter(modifier => parts.includes(modifier));
  if (modifiers.length !== parts.length || [...modifiers, key].join('+') !== value) throw new Error('快捷键格式无效');
  const functionKey = /^F(?:[1-9]|10|11)$/.test(key);
  if (value === 'Alt+F4') throw new Error('Alt+F4 用于关闭窗口，请使用其他组合');
  if (!functionKey && (!/^[A-Z0-9]$/.test(key) || !modifiers.some(modifier => modifier === 'Ctrl' || modifier === 'Alt'))) {
    throw new Error('请使用 Ctrl／Alt 加字母或数字，或 F1–F11');
  }
  return { key: functionKey ? 0x6f + Number(key.slice(1)) : key.charCodeAt(0),
    modifiers: (parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Alt') ? 1 : 0) | (parts.includes('Shift') ? 4 : 0) };
}

function validateBindings(value) {
  if (!value || Object.keys(value).length !== 4 || ACTIONS.some(action => typeof value[action] !== 'string')) throw new Error('快捷键设置无效');
  ACTIONS.forEach(action => parseBinding(value[action]));
  const used = ACTIONS.map(action => value[action]).filter(Boolean);
  if (new Set(used).size !== used.length) throw new Error('动作不能使用同一快捷键');
  return { microphone: value.microphone, listening: value.listening, pushToTalk: value.pushToTalk, replay: value.replay };
}

function createAudioShortcuts({ getWindow, bridge, getReplayId = () => null, onRelease = () => {}, onActivityChanged = () => {} }) {
  let owner;
  let roomId = null;
  let suspended = false;
  let bindings = { microphone: '', listening: '', pushToTalk: '', replay: '' };
  let pushToTalk = false;
  let held = false;
  let holdSequence = 0;
  let needsRelease = false;
  let releaseTimer;
  const blockers = new Set();
  const registered = new Map();
  let hookedWindow;

  function requireOwner(token) { if (!owner || owner !== token) throw new Error('快捷键会话已失效'); }
  function updateActivity() { onActivityChanged(Boolean(owner && roomId && pushToTalk && bindings.pushToTalk && !suspended && !blockers.size)); }
  function releaseHold() {
    const wasHeld = held;
    held = false;
    holdSequence++;
    if (wasHeld) onRelease();
    if (wasHeld && owner && roomId) getWindow()?.webContents.send('audio-shortcuts:hold', { owner, roomId, sequence: holdSequence, held: false });
  }
  function pressed() {
    const binding = parseBinding(bindings.pushToTalk);
    const window = getWindow();
    return Boolean(binding && window && !window.isDestroyed()
      && bridge().audioHotkeyPressed(window.getNativeWindowHandle(), binding.modifiers, binding.key));
  }
  function unregister() {
    needsRelease ||= held;
    onActivityChanged(false);
    releaseHold();
    clearInterval(releaseTimer); releaseTimer = undefined;
    let failure;
    for (const [id, window] of registered) {
      try {
        if (!window.isDestroyed()) bridge().unregisterAudioHotkey(window.getNativeWindowHandle(), id);
        registered.delete(id);
      } catch (error) { failure ??= error; }
    }
    if (failure) throw new Error('快捷键释放失败，请重新打开客户端');
  }
  function register(next, retain) {
    const window = getWindow();
    if (!window || window.isDestroyed()) throw new Error('快捷键窗口不可用');
    try {
      ACTIONS.forEach((action, index) => {
        if (action === 'pushToTalk' && !pushToTalk) return;
        if (retain && action !== 'replay' && !roomId) return;
        const binding = parseBinding(next[action]);
        if (!binding) return;
        const id = 0x4c01 + index;
        bridge().registerAudioHotkey(window.getNativeWindowHandle(), id, binding.modifiers, binding.key);
        registered.set(id, window);
      });
    } catch {
      unregister();
      throw new Error('快捷键已被占用或系统拒绝，请更换组合后重试');
    }
    if (!retain) unregister();
  }
  function notifyError(error) {
    getWindow()?.webContents.send('audio-shortcuts:error', { owner, message: error.message });
  }
  function begin() {
    end(owner);
    unregister();
    owner = randomUUID();
    hookedWindow = getWindow();
    hookedWindow.hookWindowMessage(WM_HOTKEY, wParam => {
      const id = wParam.readUInt32LE(0);
      const action = ACTIONS[id - 0x4c01];
      if (owner && (roomId || action === 'replay') && !suspended && !blockers.size && registered.has(id) && action) {
        if (action === 'replay') {
          const replayId = getReplayId();
          if (replayId) hookedWindow.webContents.send('audio-shortcuts:action', { owner, roomId, action, replayId });
          return;
        }
        if (action === 'pushToTalk') {
          try { if (needsRelease || !pressed()) return; }
          catch { releaseHold(); notifyError(new Error('按键状态无法读取，请重新启用快捷键')); return; }
          held = true;
          hookedWindow.webContents.send('audio-shortcuts:hold', { owner, roomId, sequence: ++holdSequence, held: true });
        } else hookedWindow.webContents.send('audio-shortcuts:action', { owner, roomId, action });
      }
    });
    return owner;
  }
  function configure(token, value, nextPushToTalk = false) {
    requireOwner(token);
    const next = validateBindings(value);
    if (typeof nextPushToTalk !== 'boolean') throw new Error('发言模式无效');
    const previous = bindings;
    const previousMode = pushToTalk;
    unregister();
    suspended = false;
    pushToTalk = nextPushToTalk;
    try { register(next, false); register(next, true); }
    catch (error) {
      pushToTalk = previousMode;
      try { register(previous, true); waitForRelease(); } catch (restoreError) { notifyError(restoreError); }
      throw error;
    }
    bindings = next;
    waitForRelease();
  }
  function activate(token, nextRoom) {
    requireOwner(token);
    if (nextRoom !== null && (typeof nextRoom !== 'string' || nextRoom.length > 200 || !nextRoom)) throw new Error('快捷键房间无效');
    unregister();
    roomId = nextRoom;
    if (!suspended) register(bindings, true);
    waitForRelease();
  }
  function capture(token, enabled) {
    requireOwner(token);
    if (typeof enabled !== 'boolean') throw new Error('快捷键录入状态无效');
    unregister();
    suspended = enabled;
    if (!suspended) register(bindings, true);
    waitForRelease();
  }
  function end(token) {
    if (!owner || token !== owner) return;
    releaseHold();
    roomId = null;
    suspended = true;
    try { unregister(); }
    finally {
      hookedWindow?.unhookWindowMessage(WM_HOTKEY);
      hookedWindow = undefined;
      owner = undefined;
      bindings = { microphone: '', listening: '', pushToTalk: '', replay: '' };
      pushToTalk = false;
    }
  }
  function readHold(token, currentRoom, sequence) {
    requireOwner(token);
    if (typeof currentRoom !== 'string' || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('按键说话会话无效');
    if (!pushToTalk || !held || blockers.size || suspended || currentRoom !== roomId || sequence !== holdSequence) return false;
    if (!pressed()) { releaseHold(); return false; }
    return true;
  }
  function transmissionAllowed() {
    if (!owner || !roomId || !pushToTalk || !held || suspended || blockers.size) return false;
    try { if (pressed()) return true; }
    catch { notifyError(new Error('按键状态无法读取，请重新启用快捷键')); }
    releaseHold();
    return false;
  }
  function waitForRelease() {
    updateActivity();
    clearInterval(releaseTimer); releaseTimer = undefined;
    if (!blockers.size && !suspended && owner && roomId && pushToTalk && bindings.pushToTalk) {
      try { needsRelease ||= pressed(); }
      catch { needsRelease = true; notifyError(new Error('按键状态无法读取，请重新启用快捷键')); return; }
      if (!needsRelease) return;
      // 锁屏／休眠后必须先见到组合松开，旧的排队消息不能重新开口。
      releaseTimer = setInterval(() => {
        try { if (pressed()) return; needsRelease = false; }
        catch { notifyError(new Error('按键状态无法读取，请重新启用快捷键')); }
        clearInterval(releaseTimer); releaseTimer = undefined;
      }, 50);
      releaseTimer.unref?.();
    }
  }
  function block(reason, enabled) {
    if (enabled) { blockers.add(reason); needsRelease ||= held; releaseHold(); }
    else blockers.delete(reason);
    waitForRelease();
  }
  return { begin, configure, activate, capture, end, readHold, block, transmissionAllowed, clear: () => end(owner) };
}

module.exports = { createAudioShortcuts, parseBinding, validateBindings };
