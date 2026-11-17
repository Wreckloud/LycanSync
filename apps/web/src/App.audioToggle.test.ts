import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./App.vue', import.meta.url), 'utf8');
const start = source.indexOf('let audioToggleVersion =');
const script = transpileModule(source.slice(start, source.indexOf('const audioShortcutRoomId', start)), {}).outputText;

function fixture() {
  const listening = { value: true };
  const rtc = {
    room: {}, microphoneEnabled: true, needsAudioPlayback: false,
    toggleMedia: vi.fn(async () => { rtc.microphoneEnabled = !rtc.microphoneEnabled; }),
    updateListeningState: vi.fn(async (enabled: boolean) => { listening.value = enabled; rtc.microphoneEnabled = enabled; }),
    enableAudioPlayback: vi.fn(async () => {}),
  };
  const context = {
    listening, rtc, connected: { value: true }, localParticipant: { value: {} },
    Track: { Source: { Microphone: 'microphone' } },
    callSounds: { listeningChanged: vi.fn(), microphoneChanged: vi.fn() },
    toggleListening: undefined as unknown as () => Promise<void>,
    toggleMicrophone: undefined as unknown as () => Promise<void>,
  };
  runInNewContext(script, context);
  return context;
}

it('收听切换联动麦克风时只响收听提示，单独切麦仍响麦克风提示', async () => {
  const f = fixture();
  await f.toggleListening();
  expect(f.callSounds.listeningChanged).toHaveBeenLastCalledWith(false);
  await f.toggleListening();
  expect(f.callSounds.listeningChanged).toHaveBeenLastCalledWith(true);
  expect(f.callSounds.listeningChanged).toHaveBeenCalledTimes(2);
  expect(f.callSounds.microphoneChanged).not.toHaveBeenCalled();
  await f.toggleMicrophone();
  expect(f.callSounds.microphoneChanged).toHaveBeenCalledExactlyOnceWith(false);
});

it.each(['new-toggle', 'new-room', 'disconnected', 'unchanged'])('收听操作迟到或未生效不响旧提示：%s', async (change) => {
  const f = fixture();
  let finish!: () => void;
  f.rtc.updateListeningState.mockImplementationOnce((enabled) => {
    if (change !== 'unchanged') f.listening.value = enabled;
    return new Promise<void>(resolve => { finish = resolve; });
  });
  const pending = f.toggleListening();
  if (change === 'new-toggle') await f.toggleListening();
  if (change === 'new-room') f.rtc.room = {};
  if (change === 'disconnected') f.connected.value = false;
  f.callSounds.listeningChanged.mockClear();
  finish();
  await pending;
  expect(f.callSounds.listeningChanged).not.toHaveBeenCalled();
});
