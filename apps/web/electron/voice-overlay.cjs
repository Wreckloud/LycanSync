const { resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

const OVERLAY_URL = 'lycan://overlay/overlay.html';
const DEFAULT_SETTINGS = { enabled: false, mode: 'all', scale: 100, width: 240,
  displayId: null, x: 1, y: 0.5, includeInCapture: false };

function validateSettings(value) {
  if (!value || typeof value.enabled !== 'boolean' || !['all', 'speaking'].includes(value.mode)
      || !Number.isInteger(value.scale) || value.scale < 75 || value.scale > 150
      || !Number.isInteger(value.width) || value.width < 180 || value.width > 420
      || (value.displayId !== null && !Number.isInteger(value.displayId))
      || !Number.isFinite(value.x) || value.x < 0 || value.x > 1
      || !Number.isFinite(value.y) || value.y < 0 || value.y > 1
      || typeof value.includeInCapture !== 'boolean') throw new Error('屏幕覆盖设置无效');
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [key, value[key]]));
}

function validateSnapshot(value) {
  if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || (value.roomId !== null && (typeof value.roomId !== 'string' || value.roomId.length > 256))
      || !['connected', 'reconnecting', 'hidden'].includes(value.status)
      || !Array.isArray(value.members)) throw new Error('屏幕覆盖状态无效');
  const identities = new Set();
  const members = value.members.map((member) => {
    if (!member || typeof member.identity !== 'string' || !member.identity || member.identity.length > 256
        || identities.has(member.identity) || typeof member.name !== 'string' || member.name.length > 256
        || !['microphone', 'listening', 'speaking'].every((key) => typeof member[key] === 'boolean')) {
      throw new Error('屏幕覆盖成员无效');
    }
    identities.add(member.identity);
    return { identity: member.identity, name: member.name, microphone: member.microphone,
      listening: member.listening, speaking: member.microphone && member.listening && member.speaking };
  });
  let portraits;
  if (value.portraits !== undefined) {
    if (!Array.isArray(value.portraits) || JSON.stringify(value.portraits).length > 8 * 1024 * 1024) {
      throw new Error('屏幕覆盖头像过大');
    }
    portraits = value.portraits.map((portrait) => {
      if (!portrait || !identities.has(portrait.identity) || typeof portrait.avatar !== 'string'
          || (portrait.avatar !== '' && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(portrait.avatar))) {
        throw new Error('屏幕覆盖头像无效');
      }
      return { identity: portrait.identity, avatar: portrait.avatar };
    });
  }
  return { sequence: value.sequence, roomId: value.roomId, status: value.status, members, portraits };
}

// 独立 session 只提供覆盖页静态资源，不注册业务代理，也不接收登录凭据。
function createOverlayPage({ rendererRoot, devRendererUrl, fetch }) {
  return async (request) => {
    const url = new URL(request.url);
    if (url.protocol !== 'lycan:' || url.host !== 'overlay' || request.method !== 'GET') return new Response(null, { status: 403 });
    let path;
    try { path = decodeURIComponent(url.pathname); }
    catch { return new Response(null, { status: 400 }); }
    if (path.split(/[\\/]/).includes('..')) return new Response(null, { status: 403 });
    const allowed = path === '/overlay.html' || /^\/assets\/[\w.-]+$/.test(path)
      || (devRendererUrl && (path.startsWith('/src/overlay/') || path.startsWith('/node_modules/.vite/')
        || path === '/@vite/client' || path === '/@id/__x00__plugin-vue:export-helper'
        || path === '/node_modules/vite/dist/client/env.mjs'));
    if (!allowed) return new Response(null, { status: 404 });
    const file = resolve(rendererRoot, `.${path}`);
    if (!file.startsWith(rendererRoot + sep)) return new Response(null, { status: 403 });
    try {
      const target = devRendererUrl ? new URL(url.pathname + url.search, devRendererUrl).href : pathToFileURL(file).href;
      const response = await fetch(target);
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'");
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    } catch { return new Response(null, { status: 404 }); }
  };
}

function createVoiceOverlay({ BrowserWindow, screen, session, net, rendererRoot, devRendererUrl, defaultDisplay,
  onError, onPlacement, onEditingChange, onDiagnostic }) {
  let owner = null;
  let initialized = false;
  let overlay;
  let ready = false;
  let failed = false;
  let editing = false;
  let settings = { ...DEFAULT_SETTINGS };
  let snapshot = { sequence: -1, roomId: null, status: 'hidden', members: [] };
  let portraits = new Map();
  let lastView;
  let portraitRevision = 0;
  let appliedSettings;
  let overlaySession;
  let appliedBounds;
  let editDisplay;
  let initialDisplay;
  let holdTimer;
  let readyTimer;
  const speakingUntil = new Map();

  function reportFailure(stage) {
    if (failed) return;
    failed = true;
    editing = false;
    onDiagnostic({ stage });
    destroyWindow();
    onError('屏幕覆盖不可用，请在设置中关闭后重新开启；语音不受影响。');
  }

  function display() {
    return screen.getAllDisplays().find((item) => item.id === (settings.displayId ?? initialDisplay))
      ?? screen.getPrimaryDisplay();
  }

  function view() {
    const connected = snapshot.status === 'connected';
    return { settings, editing, status: snapshot.status, members: snapshot.members.map((member) => ({
      ...member, speaking: connected && member.speaking,
      visible: settings.mode === 'all' || (connected && (member.speaking || (speakingUntil.get(member.identity) ?? 0) > Date.now())),
      avatar: portraits.get(member.identity) ?? '',
    })) };
  }

  function place(count) {
    if (!overlay) return;
    const area = display().workArea;
    const rowHeight = Math.ceil(48 * settings.scale / 100);
    const maxRows = Math.max(1, Math.floor((area.height - 64) / rowHeight));
    const rows = Math.max(1, Math.min(count, maxRows));
    const columns = Math.max(1, Math.ceil(count / rows));
    const width = Math.min(area.width, settings.width * columns);
    const height = Math.min(area.height, rows * rowHeight + (editing ? 40 : 8));
    const bounds = { x: area.x + Math.round((area.width - width) * settings.x),
      y: area.y + Math.round((area.height - height) * settings.y), width, height };
    if (!appliedBounds || Object.keys(bounds).some((key) => appliedBounds[key] !== bounds[key])) {
      appliedBounds = bounds;
      overlay.setBounds(bounds);
    }
  }

  function destroyWindow() {
    const previous = overlay;
    overlay = undefined;
    ready = false;
    clearTimeout(readyTimer);
    lastView = undefined;
    appliedSettings = undefined;
    appliedBounds = undefined;
    if (previous && !previous.isDestroyed()) previous.destroy();
  }

  function refreshWindow() {
    const visible = owner && settings.enabled && (editing || (snapshot.roomId && snapshot.status !== 'hidden'));
    if (!visible || failed) { destroyWindow(); return; }
    if (!overlay) {
      overlay = new BrowserWindow({ width: settings.width, height: 64, show: false,
        frame: false, transparent: true, hasShadow: false, resizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, focusable: editing, title: 'LycanSync 屏幕覆盖',
        webPreferences: { session: overlaySession, preload: resolve(__dirname, 'voice-overlay-preload.cjs'),
          contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
      });
      const current = overlay;
      readyTimer = setTimeout(() => {
        if (overlay === current && !ready) reportFailure('voiceOverlayReadyTimeout');
      }, 10_000);
      // 在第一次显示前设置捕获策略，避免先显示后排除造成可见首帧。
      current.setContentProtection(!settings.includeInCapture);
      current.setAlwaysOnTop(true, 'screen-saver');
      current.setIgnoreMouseEvents(!editing);
      appliedSettings = { editing, includeInCapture: settings.includeInCapture };
      onDiagnostic({ stage: 'voiceOverlayCreated', editing, captureExcluded: !settings.includeInCapture });
      current.setMenu(null);
      current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      current.webContents.on('will-navigate', (event) => event.preventDefault());
      current.webContents.on('will-attach-webview', (event) => event.preventDefault());
      current.webContents.on('render-process-gone', () => { if (overlay === current) reportFailure('voiceOverlayRendererGone'); });
      current.webContents.on('did-fail-load', () => { if (overlay === current) reportFailure('voiceOverlayLoadFailed'); });
      current.on('closed', () => {
        if (overlay === current) reportFailure('voiceOverlayClosedUnexpectedly');
      });
      let userMoving = false;
      current.on('will-move', () => { userMoving = editing; });
      current.on('moved', () => {
        if (overlay !== current || !editing || !userMoving) return;
        userMoving = false;
        if (!screen.getAllDisplays().some((item) => item.id === (settings.displayId ?? initialDisplay))) {
          correctPlacement();
          return;
        }
        const bounds = current.getBounds();
        // 系统校正与程序布局不保存为用户拖动，断屏时仍保留原显示器偏好。
        if (appliedBounds && Object.keys(bounds).every((key) => Math.abs(bounds[key] - appliedBounds[key]) <= 1)) return;
        const target = screen.getDisplayMatching(bounds);
        const area = target.workArea;
        settings = { ...settings, displayId: target.id,
          x: Math.max(0, Math.min(1, (bounds.x - area.x) / Math.max(1, area.width - bounds.width))),
          y: Math.max(0, Math.min(1, (bounds.y - area.y) / Math.max(1, area.height - bounds.height))) };
        editDisplay = target.id;
        appliedBounds = bounds;
        onPlacement(settings);
      });
      void current.loadURL(OVERLAY_URL).catch(() => { if (overlay === current) reportFailure('voiceOverlayLoadFailed'); });
    }
    if (appliedSettings.includeInCapture !== settings.includeInCapture) overlay.setContentProtection(!settings.includeInCapture);
    if (appliedSettings.editing !== editing) {
      overlay.setFocusable(editing);
      overlay.setIgnoreMouseEvents(!editing);
    }
    appliedSettings = { editing, includeInCapture: settings.includeInCapture };
    const nextView = view();
    const count = editing ? Math.max(2, snapshot.members.length) : nextView.members.filter((member) => member.visible).length;
    place(count);
    if (ready) {
      // 头像仅随资料变化发送，说话事件只携带轻量成员状态。
      const roster = `${portraitRevision}:${JSON.stringify(nextView.members.map(({ identity, name }) => ({ identity, name })))}`;
      const message = { ...nextView, members: nextView.members.map(({ avatar, ...member }) => member) };
      if (lastView !== roster) message.portraits = nextView.members.map(({ identity, avatar }) => ({ identity, avatar }));
      lastView = roster;
      overlay.webContents.send('voice-overlay:view', message);
      if ((count || editing) && !overlay.isVisible()) overlay.showInactive();
      else if (!count && !editing && overlay.isVisible()) overlay.hide();
    }
  }

  function refresh() {
    try { refreshWindow(); }
    catch { reportFailure('voiceOverlayWindowFailed'); }
  }

  function initialize() {
    try {
      overlaySession = session.fromPartition('voice-overlay');
      overlaySession.protocol.handle('lycan', createOverlayPage({ rendererRoot, devRendererUrl, fetch: (url) => net.fetch(url) }));
      overlaySession.setPermissionCheckHandler(() => false);
      overlaySession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      overlaySession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      overlaySession.on('will-download', (event) => event.preventDefault());
      overlaySession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !details.url.startsWith('lycan://overlay/') && !details.url.startsWith('data:image/') });
      });
      initialized = true;
    } catch { reportFailure('voiceOverlayInitializationFailed'); }
  }

  function clear() {
    owner = null;
    editing = false;
    failed = false;
    snapshot = { sequence: -1, roomId: null, status: 'hidden', members: [] };
    portraits.clear();
    speakingUntil.clear();
    clearTimeout(holdTimer);
    destroyWindow();
  }

  function requireOwner(token) {
    if (!owner || token !== owner) throw new Error('屏幕覆盖会话已结束');
  }

  function scheduleSpeakingExpiry() {
    clearTimeout(holdTimer);
    const now = Date.now();
    const expiry = [...speakingUntil.values()].filter((until) => Number.isFinite(until) && until > now);
    if (expiry.length) holdTimer = setTimeout(() => {
      refresh();
      scheduleSpeakingExpiry();
    }, Math.min(...expiry) - now);
  }

  function correctPlacement() {
    if (!overlay) return;
    appliedBounds = undefined;
    if (editing && !screen.getAllDisplays().some((item) => item.id === (editDisplay ?? initialDisplay))) {
      editing = false;
      onEditingChange(false);
    }
    refresh();
  }

  return {
    initialize,
    begin() {
      if (!initialized) throw new Error('屏幕覆盖初始化失败');
      clear(); initialDisplay = defaultDisplay(); owner = randomUUID(); return owner;
    },
    end(token) { if (token === owner) clear(); },
    clear,
    configure(token, value) {
      requireOwner(token);
      const next = validateSettings(value);
      if (failed && next.enabled) throw new Error('请先关闭覆盖再重新开启');
      if (!settings.enabled || (next.displayId === null && settings.displayId !== null)) initialDisplay = defaultDisplay();
      if (!next.enabled) {
        editing = false;
        failed = false;
        snapshot = { ...snapshot, roomId: null, status: 'hidden', members: [] };
        portraits.clear();
        speakingUntil.clear();
        clearTimeout(holdTimer);
      }
      if (settings.displayId !== next.displayId) editDisplay = next.displayId;
      settings = next;
      onDiagnostic({ stage: 'voiceOverlayConfigured', enabled: settings.enabled, mode: settings.mode,
        captureExcluded: !settings.includeInCapture, scale: settings.scale, width: settings.width });
      refresh();
      return settings;
    },
    update(token, value) {
      requireOwner(token);
      if (!settings.enabled) return;
      const next = validateSnapshot(value);
      if (next.sequence <= snapshot.sequence) return;
      if (snapshot.roomId !== next.roomId) { portraits.clear(); speakingUntil.clear(); lastView = undefined; }
      if (next.portraits) {
        portraits = new Map(next.portraits.map((item) => [item.identity, item.avatar]));
        portraitRevision++;
      }
      const identities = new Set(next.members.map((member) => member.identity));
      for (const identity of portraits.keys()) if (!identities.has(identity)) portraits.delete(identity);
      const now = Date.now();
      for (const member of next.members) {
        if (next.status !== 'connected' || !member.microphone || !member.listening) speakingUntil.delete(member.identity);
        else if (member.speaking) speakingUntil.set(member.identity, Infinity);
        else if (speakingUntil.get(member.identity) === Infinity) speakingUntil.set(member.identity, now + 500);
      }
      for (const identity of speakingUntil.keys()) if (!identities.has(identity)) speakingUntil.delete(identity);
      snapshot = next;
      scheduleSpeakingExpiry();
      refresh();
    },
    edit(token, enabled) {
      requireOwner(token);
      if (typeof enabled !== 'boolean') throw new Error('编辑状态无效');
      if (failed && enabled) throw new Error('请先关闭覆盖再重新开启');
      editing = settings.enabled && enabled;
      editDisplay = settings.displayId;
      refresh();
      return editing;
    },
    ready(event) {
      if (!overlay || event.sender !== overlay.webContents || event.senderFrame !== overlay.webContents.mainFrame
          || event.senderFrame.url !== OVERLAY_URL) throw new Error('请求来源无效');
      ready = true;
      clearTimeout(readyTimer);
      refresh();
    },
    correctPlacement,
    displays() { return screen.getAllDisplays().map(({ id, label }, index) => ({ id, label: `屏幕 ${index + 1}${label ? ` · ${label}` : ''}` })); },
  };
}

module.exports = { createVoiceOverlay, createOverlayPage, validateSettings, validateSnapshot, DEFAULT_SETTINGS };
