const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAudioShortcuts, parseBinding, validateBindings } = require('./audio-shortcuts.cjs');
const { createMediaBackgroundPolicy } = require('./media-background.cjs');

function fixture() {
  const registered = new Map(), sent = [], hooks = new Map();
  let rejectedKey;
  let held = false;
  const releases = [];
  const window = { isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8, 1),
    hookWindowMessage: (id, fn) => hooks.set(id, fn), unhookWindowMessage: id => hooks.delete(id),
    webContents: { send: (...message) => sent.push(message) } };
  const bridge = {
    audioHotkeyPressed: () => held,
    registerAudioHotkey: (_window, id, modifiers, key) => {
      if (key === rejectedKey) throw new Error('occupied');
      assert.equal(registered.has(id), false);
      registered.set(id, { modifiers, key });
    },
    unregisterAudioHotkey: (_window, id) => { assert.equal(registered.delete(id), true); },
  };
  const shortcuts = createAudioShortcuts({ getWindow: () => window, bridge: () => bridge, onRelease: () => releases.push(true) });
  const owner = shortcuts.begin();
  return { shortcuts, owner, registered, sent, hooks, releases, setHeld: value => { held = value; }, rejectKey: key => { rejectedKey = key; },
    press: id => { const param = Buffer.alloc(8); param.writeUInt32LE(id); hooks.get(0x0312)?.(param); } };
}

test('只接受固定组合和两个不同的音频动作', () => {
  assert.deepEqual(parseBinding('Ctrl+Alt+Shift+M'), { modifiers: 7, key: 77 });
  assert.deepEqual(parseBinding('F11'), { modifiers: 0, key: 122 });
  for (const value of ['M', 'Shift+F', 'F12', 'Win+M', 'Alt+F4', 'Ctrl+Ctrl+M', 'Alt+Ctrl+M', null]) {
    assert.throws(() => parseBinding(value));
  }
  assert.throws(() => validateBindings({ microphone: 'Ctrl+M', listening: 'Ctrl+M', pushToTalk: '' }));
  assert.throws(() => validateBindings({ microphone: '', listening: '', other: '' }));
});

test('按键说话仅在启用时注册，真实松开后撤销授权，旧房间与旧按下不能续期', () => {
  const f = fixture();
  const bindings = { microphone: '', listening: '', pushToTalk: 'F2' };
  f.shortcuts.configure(f.owner, bindings, false);
  f.shortcuts.activate(f.owner, 'room');
  assert.equal(f.registered.size, 0);
  f.shortcuts.configure(f.owner, bindings, true);
  assert.equal(f.registered.has(0x4c03), true);
  f.setHeld(true); f.press(0x4c03);
  const first = f.sent.at(-1)[1];
  assert.equal(first.held, true);
  assert.equal(f.shortcuts.readHold(f.owner, 'room', first.sequence), true);
  assert.equal(f.shortcuts.readHold(f.owner, 'old-room', first.sequence), false);
  f.setHeld(false);
  assert.equal(f.shortcuts.readHold(f.owner, 'room', first.sequence), false);
  assert.equal(f.releases.length, 1);
  assert.equal(f.sent.at(-1)[1].held, false);
  f.setHeld(true); f.press(0x4c03);
  const next = f.sent.at(-1)[1];
  assert.equal(f.shortcuts.readHold(f.owner, 'room', first.sequence), false);
  assert.equal(f.shortcuts.readHold(f.owner, 'room', next.sequence), true);
  f.shortcuts.end(f.owner);
});

test('锁屏与休眠分别拦住按键，恢复后必须松开旧组合再按；结束回收等待计时器', async () => {
  const f = fixture();
  f.shortcuts.configure(f.owner, { microphone: '', listening: '', pushToTalk: 'F2' }, true);
  f.shortcuts.activate(f.owner, 'room');
  f.setHeld(true); f.press(0x4c03);
  f.shortcuts.block('lock', true);
  f.shortcuts.block('sleep', true);
  assert.equal(f.releases.length, 1);
  f.shortcuts.block('sleep', false);
  f.press(0x4c03);
  assert.equal(f.sent.at(-1)[1].held, false);
  f.shortcuts.block('lock', false);
  f.press(0x4c03);
  assert.equal(f.sent.at(-1)[1].held, false);
  f.setHeld(false);
  await new Promise(resolve => setTimeout(resolve, 65));
  f.setHeld(true); f.press(0x4c03);
  assert.equal(f.sent.at(-1)[1].held, true);
  f.shortcuts.end(f.owner);
  assert.equal(f.registered.size, 0);
});

test('共享与按键说话按任意顺序结束，最后一个用途才恢复原页面节流状态', () => {
  for (const original of [false, true]) {
    for (const first of ['video', 'pushToTalk']) {
      const update = createMediaBackgroundPolicy();
      let current = original;
      const renderer = { isDestroyed: () => false, getBackgroundThrottling: () => current,
        setBackgroundThrottling: value => { current = value; } };
      const second = first === 'video' ? 'pushToTalk' : 'video';
      update(renderer, first, true);
      update(renderer, second, true);
      assert.equal(current, false);
      update(renderer, first, false);
      assert.equal(current, false);
      update(renderer, second, false);
      assert.equal(current, original);
    }
  }
});

test('只在当前通话注册，事件只包含动作和会话，离房释放', () => {
  const f = fixture();
  f.shortcuts.configure(f.owner, { microphone: 'Ctrl+M', listening: 'Alt+F2', pushToTalk: '' });
  assert.equal(f.registered.size, 0);
  f.shortcuts.activate(f.owner, 'room-one');
  assert.equal(f.registered.size, 2);
  f.press(0x4c01);
  assert.deepEqual(f.sent, [['audio-shortcuts:action', { owner: f.owner, roomId: 'room-one', action: 'microphone' }]]);
  f.shortcuts.activate(f.owner, null);
  f.press(0x4c01);
  assert.equal(f.sent.length, 1);
  assert.equal(f.registered.size, 0);
});

test('录入暂停两项绑定，冲突恢复原绑定且不会假报配置成功', () => {
  const f = fixture();
  f.shortcuts.configure(f.owner, { microphone: 'Ctrl+M', listening: 'Ctrl+L', pushToTalk: '' });
  f.shortcuts.activate(f.owner, 'room');
  f.shortcuts.capture(f.owner, true);
  assert.equal(f.registered.size, 0);
  f.press(0x4c01);
  assert.equal(f.sent.length, 0);
  f.rejectKey(75);
  assert.throws(() => f.shortcuts.configure(f.owner, { microphone: 'Ctrl+K', listening: 'Ctrl+L', pushToTalk: '' }), /占用/);
  assert.equal(f.registered.get(0x4c01).key, 77);
  assert.equal(f.registered.get(0x4c02).key, 76);
});

test('失效会话不能修改配置或清理新会话，结束后释放窗口消息钩子', () => {
  const f = fixture();
  const next = f.shortcuts.begin();
  assert.throws(() => f.shortcuts.activate(f.owner, 'old'), /失效/);
  f.shortcuts.configure(next, { microphone: 'Ctrl+M', listening: '', pushToTalk: '' });
  f.shortcuts.activate(next, 'new');
  f.shortcuts.end(f.owner);
  assert.equal(f.registered.size, 1);
  f.shortcuts.end(next);
  assert.equal(f.registered.size, 0);
  assert.equal(f.hooks.size, 0);
});
