import { describe, expect, it } from 'vitest';
import { entranceSoundToFile, loadEntranceSound, saveEntranceSound,
  type StoredEntranceSound } from './entranceSound';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('entranceSound', () => {
  it('按账号保存、读取和移除本机入场音效', () => {
    const storage = memoryStorage();
    const sound: StoredEntranceSound = {
      name: 'hello.mp3',
      mimeType: 'audio/mpeg',
      dataUrl: 'data:audio/mpeg;base64,AQID',
    };
    expect(saveEntranceSound('user-a', sound, storage)).toBe(true);
    expect(loadEntranceSound('user-a', storage)).toEqual(sound);
    expect(loadEntranceSound('user-b', storage)).toBeNull();
    expect(saveEntranceSound('user-a', null, storage)).toBe(true);
    expect(loadEntranceSound('user-a', storage)).toBeNull();
  });

  it('拒绝不支持或损坏的本地内容', () => {
    const storage = memoryStorage();
    storage.setItem('lycansync.entrance-sound.v1.user-a', JSON.stringify({
      name: 'payload.exe',
      mimeType: 'application/octet-stream',
      dataUrl: 'data:application/octet-stream;base64,AQID',
    }));
    expect(loadEntranceSound('user-a', storage)).toBeNull();
  });

  it('恢复发送所需的文件名、类型和字节', async () => {
    const file = entranceSoundToFile({
      name: 'hello.ogg',
      mimeType: 'audio/ogg',
      dataUrl: 'data:audio/ogg;base64,AQID',
    });
    expect(file.name).toBe('hello.ogg');
    expect(file.type).toBe('audio/ogg');
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
