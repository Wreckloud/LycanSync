const { randomUUID } = require('node:crypto');

const ACTIONS = ['microphone', 'listening'];
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
  if (!value || Object.keys(value).length !== 2 || ACTIONS.some(action => typeof value[action] !== 'string')) throw new Error('快捷键设置无效');
  ACTIONS.forEach(action => parseBinding(value[action]));
  if (value.microphone && value.microphone === value.listening) throw new Error('两个动作不能使用同一快捷键');
  return { microphone: value.microphone, listening: value.listening };
}

function createAudioShortcuts({ getWindow, bridge }) {
  let owner;
  let roomId = null;
  let suspended = false;
  let bindings = { microphone: '', listening: '' };
  const registered = new Map();
  let hookedWindow;

  function requireOwner(token) { if (!owner || owner !== token) throw new Error('快捷键会话已失效'); }
  function unregister() {
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
      if (owner && roomId && !suspended && registered.has(id) && action) {
        hookedWindow.webContents.send('audio-shortcuts:action', { owner, roomId, action });
      }
    });
    return owner;
  }
  function configure(token, value) {
    requireOwner(token);
    const next = validateBindings(value);
    const previous = bindings;
    unregister();
    suspended = false;
    try { register(next, Boolean(roomId)); }
    catch (error) {
      try { register(previous, Boolean(roomId)); } catch (restoreError) { notifyError(restoreError); }
      throw error;
    }
    bindings = next;
  }
  function activate(token, nextRoom) {
    requireOwner(token);
    if (nextRoom !== null && (typeof nextRoom !== 'string' || nextRoom.length > 200 || !nextRoom)) throw new Error('快捷键房间无效');
    unregister();
    roomId = nextRoom;
    if (roomId && !suspended) register(bindings, true);
  }
  function capture(token, enabled) {
    requireOwner(token);
    if (typeof enabled !== 'boolean') throw new Error('快捷键录入状态无效');
    unregister();
    suspended = enabled;
    if (!suspended && roomId) register(bindings, true);
  }
  function end(token) {
    if (!owner || token !== owner) return;
    roomId = null;
    suspended = true;
    try { unregister(); }
    finally {
      hookedWindow?.unhookWindowMessage(WM_HOTKEY);
      hookedWindow = undefined;
      owner = undefined;
      bindings = { microphone: '', listening: '' };
    }
  }
  return { begin, configure, activate, capture, end, clear: () => end(owner) };
}

module.exports = { createAudioShortcuts, parseBinding, validateBindings };
