import { authenticatedFetch, readApiError } from '../auth/authApi';

export const ENTRANCE_SOUND_TOPIC = 'lycansync.entrance-sound.v1';
export const ENTRANCE_SOUND_MAX_BYTES = 512 * 1024;
export const ENTRANCE_SOUND_MAX_DURATION_SECONDS = 5;

const STORAGE_PREFIX = 'lycansync.entrance-sound.v1.';
const ALLOWED_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
]);

export interface StoredEntranceSound {
  name: string;
  mimeType: string;
  dataUrl: string;
  normalization: 'rms-v1';
}

export function isSupportedEntranceSoundType(mimeType: string) {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

function byteLength(dataUrl: string) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) return 0;
  const encoded = dataUrl.slice(comma + 1);
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.floor(encoded.length * 3 / 4) - padding;
}

function isValidStoredSound(value: unknown): value is StoredEntranceSound {
  if (!value || typeof value !== 'object') return false;
  const sound = value as Partial<StoredEntranceSound>;
  return typeof sound.name === 'string' && sound.name.length > 0 && sound.name.length <= 128
    && sound.mimeType === 'audio/wav' && sound.normalization === 'rms-v1'
    && typeof sound.dataUrl === 'string'
    && sound.dataUrl.startsWith(`data:${sound.mimeType};base64,`)
    && byteLength(sound.dataUrl) > 0 && byteLength(sound.dataUrl) <= ENTRANCE_SOUND_MAX_BYTES;
}

export function loadEntranceSound(userId: string,
  storage: Pick<Storage, 'getItem'> = localStorage): StoredEntranceSound | null {
  try {
    const stored = storage.getItem(STORAGE_PREFIX + userId);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    return isValidStoredSound(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveEntranceSound(userId: string, sound: StoredEntranceSound | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage) {
  try {
    if (sound === null) storage.removeItem(STORAGE_PREFIX + userId);
    else if (isValidStoredSound(sound)) storage.setItem(STORAGE_PREFIX + userId, JSON.stringify(sound));
    else return false;
    return true;
  } catch {
    return false;
  }
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取入场音效文件'));
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('无法读取入场音效文件'));
    reader.readAsDataURL(file);
  });
}

export async function createEntranceSound(file: File, signal?: AbortSignal): Promise<StoredEntranceSound> {
  if (!isSupportedEntranceSoundType(file.type)) throw new Error('仅支持 MP3、OGG、WAV 或 WebM 音频');
  if (file.size <= 0 || file.size > ENTRANCE_SOUND_MAX_BYTES) throw new Error('入场音效不能超过 512 KB');

  const response = await authenticatedFetch('/api/audio/entrance-sound/normalize', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Accept: 'audio/wav' }, body: file,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await readApiError(response);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength <= 44 || bytes.byteLength > ENTRANCE_SOUND_MAX_BYTES
      || response.headers.get('Content-Type')?.split(';')[0].trim() !== 'audio/wav') throw new Error('服务器返回的规范音效无效');
  const view = new DataView(bytes);
  const header = new TextDecoder('ascii').decode(new Uint8Array(bytes, 0, 44));
  if (!header.startsWith('RIFF') || header.slice(8, 16) !== 'WAVEfmt ' || header.slice(36, 40) !== 'data'
      || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
      || view.getUint32(24, true) !== 48000 || view.getUint16(34, true) !== 16
      || view.getUint32(40, true) !== bytes.byteLength - 44 || (bytes.byteLength - 44) / 96000 > 5) {
    throw new Error('服务器返回的规范音效无效');
  }
  return {
    name: (file.name.replace(/\.[^.]+$/, '').slice(0, 124) || 'entrance-sound') + '.wav',
    mimeType: 'audio/wav', normalization: 'rms-v1',
    dataUrl: await readAsDataUrl(new File([bytes], 'entrance.wav', { type: 'audio/wav' })),
  };
}

export function entranceSoundToFile(sound: StoredEntranceSound) {
  if (!isValidStoredSound(sound)) throw new Error('本机保存的入场音效已损坏');
  const encoded = sound.dataUrl.slice(sound.dataUrl.indexOf(',') + 1);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], sound.name, { type: sound.mimeType });
}
