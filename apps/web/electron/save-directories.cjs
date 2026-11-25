const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { isAbsolute, join, relative } = require('node:path');

function createSaveDirectories(dataDirectory, recording) {
  const defaultExport = join(dataDirectory, 'exports');
  const config = join(dataDirectory, 'diagnostic-export-directory.json');
  let changing = false;

  async function exportDirectory() {
    try {
      const { directory } = JSON.parse(await readFile(config, 'utf8'));
      if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('日志目录配置无效');
      return directory;
    } catch (error) {
      if (error.code === 'ENOENT') return defaultExport;
      throw error;
    }
  }

  async function location(kind) {
    const isRecording = kind === 'recording';
    const defaultPath = isRecording ? recording.defaultDirectory : defaultExport;
    const path = isRecording ? (await recording.load()).directory : await exportDirectory();
    return { path, defaultPath, isDefault: relative(path, defaultPath) === '' };
  }

  async function operate(kind, action, { allowed, choose, open }) {
    if (!allowed() || !['recording', 'diagnostics'].includes(kind)
        || !['read', 'choose', 'reset', 'open'].includes(action)) throw new Error('目录操作无效');
    const current = await location(kind);
    if (!allowed()) throw new Error('目录操作已结束');
    if (action === 'read') return current;
    if (action === 'open') {
      await mkdir(current.path, { recursive: true });
      if (!allowed()) throw new Error('目录操作已结束');
      if (await open(current.path)) throw new Error('无法打开保存目录');
      return current;
    }
    if (changing || (kind === 'recording' && (recording.active || recording.replay))) throw new Error('当前不能更改保存位置');
    changing = true;
    try {
      const path = action === 'reset' ? current.defaultPath : await choose(current.path);
      if (!allowed()) throw new Error('目录操作已结束');
      if (path === null) return current;
      if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('保存目录无效');
      if (relative(current.path, path) === '') return current;
      if (kind === 'recording') await recording.configure({ directory: path });
      else if (relative(path, defaultExport) === '') await rm(config, { force: true });
      else {
        await mkdir(dataDirectory, { recursive: true });
        await writeFile(config + '.pending', JSON.stringify({ directory: path }), 'utf8');
        await rename(config + '.pending', config);
      }
      return { path, defaultPath: current.defaultPath, isDefault: relative(path, current.defaultPath) === '' };
    } finally { changing = false; }
  }
  return { exportDirectory, operate };
}

module.exports = { createSaveDirectories };
