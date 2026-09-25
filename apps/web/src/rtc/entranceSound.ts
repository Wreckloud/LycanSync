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
    && typeof sound.mimeType === 'string' && isSupportedEntranceSoundType(sound.mimeType)
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

export async function createEntranceSound(file: File): Promise<StoredEntranceSound> {
  if (!isSupportedEntranceSoundType(file.type)) throw new Error('仅支持 MP3、OGG、WAV 或 WebM 音频');
  if (file.size <= 0 || file.size > ENTRANCE_SOUND_MAX_BYTES) throw new Error('入场音效不能超过 512 KB');

  const AudioContextClass = window.AudioContext;
  const context = new AudioContextClass();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error('无法识别音频时长');
    if (buffer.duration > ENTRANCE_SOUND_MAX_DURATION_SECONDS + 0.05) {
      throw new Error('入场音效不能超过 5 秒');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('入场音效')) throw error;
    throw new Error('无法解码这段音频，请改用 MP3、OGG、WAV 或 WebM');
  } finally {
    void context.close();
  }

  return {
    name: file.name.slice(0, 128) || 'entrance-sound',
    mimeType: file.type,
    dataUrl: await readAsDataUrl(file),
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
