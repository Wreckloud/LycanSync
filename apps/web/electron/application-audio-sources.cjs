const { randomUUID } = require('node:crypto');

const applications = new Map([
  ['qqmusic.exe', ['qqmusic', 'QQ 音乐']],
  ['cloudmusic.exe', ['netease', '网易云音乐']],
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
      applications.has(target.executable) && (!browsers.has(target.executable) || target.windowTitle));
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
      const name = counts.get(target.executable) > 1 ? app[1] + ' · ' + (target.windowTitle || target.pid) : app[1];
      sources.push({ id, application: app[0], name });
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
