const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAudioShortcuts, parseBinding, validateBindings } = require('./audio-shortcuts.cjs');

function fixture() {
  const registered = new Map(), sent = [], hooks = new Map();
  let rejectedKey;
  const window = { isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8, 1),
    hookWindowMessage: (id, fn) => hooks.set(id, fn), unhookWindowMessage: id => hooks.delete(id),
    webContents: { send: (...message) => sent.push(message) } };
  const bridge = {
    registerAudioHotkey: (_window, id, modifiers, key) => {
      if (key === rejectedKey) throw new Error('occupied');
      assert.equal(registered.has(id), false);
      registered.set(id, { modifiers, key });
    },
    unregisterAudioHotkey: (_window, id) => { assert.equal(registered.delete(id), true); },
  };
  const shortcuts = createAudioShortcuts({ getWindow: () => window, bridge: () => bridge });
  const owner = shortcuts.begin();
  return { shortcuts, owner, registered, sent, hooks, rejectKey: key => { rejectedKey = key; },
    press: id => { const param = Buffer.alloc(8); param.writeUInt32LE(id); hooks.get(0x0312)?.(param); } };
}

test('只接受固定组合和两个不同的音频动作', () => {
  assert.deepEqual(parseBinding('Ctrl+Alt+Shift+M'), { modifiers: 7, key: 77 });
  assert.deepEqual(parseBinding('F11'), { modifiers: 0, key: 122 });
  for (const value of ['M', 'Shift+F', 'F12', 'Win+M', 'Alt+F4', 'Ctrl+Ctrl+M', 'Alt+Ctrl+M', null]) {
    assert.throws(() => parseBinding(value));
  }
  assert.throws(() => validateBindings({ microphone: 'Ctrl+M', listening: 'Ctrl+M' }));
  assert.throws(() => validateBindings({ microphone: '', listening: '', other: '' }));
});

test('只在当前通话注册，事件只包含动作和会话，离房释放', () => {
  const f = fixture();
  f.shortcuts.configure(f.owner, { microphone: 'Ctrl+M', listening: 'Alt+F2' });
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
  f.shortcuts.configure(f.owner, { microphone: 'Ctrl+M', listening: 'Ctrl+L' });
  f.shortcuts.activate(f.owner, 'room');
  f.shortcuts.capture(f.owner, true);
  assert.equal(f.registered.size, 0);
  f.press(0x4c01);
  assert.equal(f.sent.length, 0);
  f.rejectKey(75);
  assert.throws(() => f.shortcuts.configure(f.owner, { microphone: 'Ctrl+K', listening: 'Ctrl+L' }), /占用/);
  assert.equal(f.registered.get(0x4c01).key, 77);
  assert.equal(f.registered.get(0x4c02).key, 76);
});

test('失效会话不能修改配置或清理新会话，结束后释放窗口消息钩子', () => {
  const f = fixture();
  const next = f.shortcuts.begin();
  assert.throws(() => f.shortcuts.activate(f.owner, 'old'), /失效/);
  f.shortcuts.configure(next, { microphone: 'Ctrl+M', listening: '' });
  f.shortcuts.activate(next, 'new');
  f.shortcuts.end(f.owner);
  assert.equal(f.registered.size, 1);
  f.shortcuts.end(next);
  assert.equal(f.registered.size, 0);
  assert.equal(f.hooks.size, 0);
});
