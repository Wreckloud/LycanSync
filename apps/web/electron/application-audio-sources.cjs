const { randomUUID } = require('node:crypto');

const applications = new Map([
  ['qqmusic.exe', ['qqmusic', 'QQ 音乐']],
  ['cloudmusic.exe', ['netease', '网易云音乐']],
  ['kugou.exe', ['kugou', '酷狗音乐']],
  ['kwmusic.exe', ['kuwo', '酷我音乐']],
  ['sodamusic.exe', ['soda', '汽水音乐']],
  ['potplayermini64.exe', ['potplayer', 'PotPlayer']],
  ['potplayermini.exe', ['potplayer', 'PotPlayer']],
  ['microsoft.media.player.exe', ['mediaplayer', '媒体播放器']],
  ['wmplayer.exe', ['legacyplayer', 'Windows Media Player']],
  ['video.ui.exe', ['moviestv', '电影和电视']],
  ['vlc.exe', ['vlc', 'VLC']],
  ['spotify.exe', ['spotify', 'Spotify']],
  ['chrome.exe', ['chrome', 'Google Chrome']],
  ['msedge.exe', ['edge', 'Microsoft Edge']],
  ['firefox.exe', ['firefox', 'Firefox']],
]);

const browsers = new Set(['chrome.exe', 'msedge.exe', 'firefox.exe']);

function createApplicationAudioSources(enumerate) {
  let targets = new Map();
  function list() {
    const processes = enumerate([...applications.keys()]).filter(target =>
      target.windowTitle || (applications.has(target.executable) && !browsers.has(target.executable)));
    const counts = new Map();
    for (const target of processes) counts.set(target.executable, (counts.get(target.executable) ?? 0) + 1);
    const next = new Map();
    const sources = [];
    for (const target of processes) {
      const app = applications.get(target.executable);
      const existing = [...targets].find(([, old]) => old.pid === target.pid && old.creation === target.creation
        && old.executable === target.executable);
      const id = existing?.[0] ?? randomUUID();
      next.set(id, target);
      let name = app?.[1] ?? target.executable.replace(/\.exe$/i, '');
      if (!app || counts.get(target.executable) > 1) name += ' · ' + (target.windowTitle || target.pid);
      // 发布名称会传给队友，自定义应用的窗口标题仅用于本机选择。
      sources.push({ id, application: app?.[0] ?? 'other', name });
    }
    targets = next;
    return sources;
  }
  function resolve(id) {
    const target = targets.get(id);
    if (!target) throw new Error('applicationAudioSourceExpired');
    return target;
  }
  return { list, resolve };
}
module.exports = { createApplicationAudioSources };
