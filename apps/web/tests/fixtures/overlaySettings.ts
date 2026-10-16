import { createApp, defineComponent, h, ref } from 'vue';
import OverlaySettings from '../../src/components/settings/OverlaySettings.vue';
import { useVoiceOverlay } from '../../src/overlay/useVoiceOverlay';
import type { VoiceOverlayBridge, VoiceOverlaySettings } from '../../src/overlay/types';
import '../../src/styles.css';

const calls: string[] = [];
let rejectNext = false;
const bridge: VoiceOverlayBridge = {
  begin: async () => 'test-owner',
  configure: async (_owner, settings) => {
    if (rejectNext) { rejectNext = false; throw new Error('synthetic failure'); }
    calls.push('configure'); return settings;
  },
  edit: async (_owner, enabled) => { calls.push(`edit:${enabled}`); return enabled; },
  update: async () => {}, end: async () => {}, displays: async () => [{ id: 1, label: '屏幕 1' }],
  onError: () => () => {}, onPlacement: () => () => {}, onEditingChange: () => () => {},
};
const mounted = ref(true);
const active = ref(true);
let saved: VoiceOverlaySettings | null = null;
Object.assign(window, { overlaySettingsTest: { calls,
  rejectNext: () => { rejectNext = true; },
  setActive: (value: boolean) => { active.value = value; },
  unmount: () => { mounted.value = false; },
  saved: () => saved,
} });
createApp(defineComponent({
  setup() {
    const overlay = useVoiceOverlay({ userId: 'synthetic', room: () => null, revision: () => 0, status: () => 'idle',
      microphone: () => false, listening: () => true, avatar: () => '', bridge,
      storage: { getItem: () => null, setItem: (_key, value) => { saved = JSON.parse(value) as VoiceOverlaySettings; } },
    });
    return () => mounted.value ? h('main', { style: 'height:100%;overflow:auto;padding:24px;max-width:820px' }, [
      h(OverlaySettings, { overlay, active: active.value }),
    ]) : null;
  },
})).mount('#root');
