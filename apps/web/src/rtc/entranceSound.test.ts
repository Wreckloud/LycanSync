import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../auth/authApi';
import { createEntranceSound, entranceSoundToFile, loadEntranceSound, saveEntranceSound,
  type StoredEntranceSound } from './entranceSound';

vi.mock('../auth/authApi', () => ({ authenticatedFetch: vi.fn(), readApiError: async () => new Error('服务器正在处理另一段音效') }));
afterEach(() => vi.unstubAllGlobals());

function processedWave() {
  const bytes = new Uint8Array(46);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  bytes.set(new TextEncoder().encode('data'), 36);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true); view.setUint16(34, 16, true); view.setUint32(40, 2, true);
  return bytes;
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('entranceSound', () => {
  it('选择音效只上传到固定受认证接口，保存服务端规范结果', async () => {
    vi.stubGlobal('FileReader', class {
      result = 'data:audio/wav;base64,AQID';
      onload?: () => void;
      readAsDataURL() { this.onload?.(); }
    });
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(processedWave(), { headers: { 'Content-Type': 'audio/wav' } }));
    const file = new File(['mp3-data'], '入场.mp3', { type: 'audio/mpeg' });
    const signal = new AbortController().signal;
    const result = await createEntranceSound(file, signal);
    expect(authenticatedFetch).toHaveBeenLastCalledWith('/api/audio/entrance-sound/normalize', expect.objectContaining({ method: 'POST', body: file, signal: expect.any(AbortSignal) }));
    expect(result.normalization).toBe('rms-v1');
    expect(result.name).toBe('入场.wav');
    expect(result.mimeType).toBe('audio/wav');
  });

  it('拒绝服务器返回的任意正文，上传失败保留明确原因', async () => {
    const file = new File(['test'], '入场.wav', { type: 'audio/wav' });
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response('not-wav', { headers: { 'Content-Type': 'audio/wav' } }));
    await expect(createEntranceSound(file)).rejects.toThrow('规范音效无效');
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(createEntranceSound(file)).rejects.toThrow('另一段音效');
  });

  it('旧版未经规范的缓存不再进入正式发送路径', () => {
    const storage = memoryStorage();
    storage.setItem('lycansync.entrance-sound.v1.user-a', JSON.stringify({ name: 'old.wav', mimeType: 'audio/wav', dataUrl: 'data:audio/wav;base64,AQID' }));
    expect(loadEntranceSound('user-a', storage)).toBeNull();
  });
  it('按账号保存、读取和移除本机入场音效', () => {
    const storage = memoryStorage();
    const sound: StoredEntranceSound = {
      name: 'hello.wav', normalization: 'rms-v1',
      mimeType: 'audio/wav',
      dataUrl: 'data:audio/wav;base64,AQID',
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
      name: 'hello.wav', normalization: 'rms-v1',
      mimeType: 'audio/wav',
      dataUrl: 'data:audio/wav;base64,AQID',
    });
    expect(file.name).toBe('hello.wav');
    expect(file.type).toBe('audio/wav');
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
