const { randomUUID } = require('node:crypto');

const applications = new Map([
  ['cloudmusic.exe', ['netease', '网易云音乐']],
  ['vlc.exe', ['vlc', 'VLC']],
  ['spotify.exe', ['spotify', 'Spotify']],
  ['chrome.exe', ['chrome', 'Google Chrome']],
  ['msedge.exe', ['edge', 'Microsoft Edge']],
  ['firefox.exe', ['firefox', 'Firefox']],
]);

function createApplicationAudioSources(enumerate) {
  let targets = new Map();
  function list() {
    const processes = enumerate([...applications.keys()]);
    const next = new Map();
    const sources = [];
    for (const target of processes) {
      const app = applications.get(target.executable);
      if (!app) continue;
      const existing = [...targets].find(([, old]) => old.pid === target.pid && old.creation === target.creation
        && old.executable === target.executable);
      const id = existing?.[0] ?? randomUUID();
      next.set(id, target);
      sources.push({ id, application: app[0], name: app[1] });
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
