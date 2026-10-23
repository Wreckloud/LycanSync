<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref } from 'vue';
import InlineFeedback from './InlineFeedback.vue';

defineProps<{ name: string; busy: boolean }>();
const emit = defineEmits<{ reject: []; allow: [sourceId: string, publicVideo: boolean] }>();
const monitors = ref<Array<{ sourceId: string; title: string; primary: boolean }>>([]);
const sourceId = ref('');
const publicVideo = ref(true);
const loading = ref(false);
const error = ref('');
const dialog = ref<HTMLElement | null>(null);
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
let disposed = false;

function keepFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value) return;
  const controls = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)')];
  const first = controls[0], last = controls[controls.length - 1];
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
}

async function loadMonitors() {
  loading.value = true;
  error.value = '';
  try {
    const desktop = window.lycanDesktop;
    if (!desktop) throw new Error('desktopRequired');
    const snapshot = await desktop.listNativeVideoSources();
    if (disposed) return;
    monitors.value = snapshot.sources.filter(source => source.kind === 'monitor').map((source, index) => ({
      ...source, title: `屏幕 ${index + 1}${source.primary ? '（主显示器）' : ''}`,
    }));
    sourceId.value = (monitors.value.find(source => source.primary) ?? monitors.value[0])?.sourceId ?? '';
    if (!sourceId.value) error.value = '没有可共享的显示器，请检查显示器连接后重试。';
  } catch { if (!disposed) error.value = '未能读取显示器，请重试。'; }
  finally { if (!disposed) loading.value = false; }
}

onMounted(() => { dialog.value?.focus(); void loadMonitors(); });
onScopeDispose(() => {
  disposed = true;
  void nextTick(() => { if (returnFocus?.isConnected) returnFocus.focus(); });
});
</script>

<template>
  <div class="dialog-backdrop" @keydown.esc.stop.prevent="emit('reject')">
    <section ref="dialog" class="remote-request-card" role="dialog" aria-modal="true" aria-labelledby="remote-request-title"
      tabindex="-1" @keydown="keepFocus">
      <header><h2 id="remote-request-title">{{ name }}申请远程控制</h2>
        <p>接受后自动共享所选显示器，对方可以使用鼠标和常用键盘按键。你可以随时停止。</p></header>
      <label for="remote-control-monitor">共享显示器</label>
      <select id="remote-control-monitor" v-model="sourceId" :disabled="busy || loading">
        <option v-for="monitor in monitors" :key="monitor.sourceId" :value="monitor.sourceId">{{ monitor.title }}</option>
      </select>
      <label class="remote-public-option"><input v-model="publicVideo" type="checkbox" :disabled="busy">
        向语音频道其他成员公开画面</label>
      <p class="remote-scope-note">{{ publicVideo ? '频道成员可以观看，但只有申请者能够控制；频道语音保持不变。' : '只有申请者能观看画面，其他成员仅看到控制状态；频道语音保持不变。' }}</p>
      <footer class="card-actions">
        <button type="button" @click="emit('reject')">{{ busy ? '取消准备' : '拒绝' }}</button>
        <InlineFeedback :message="error" :status="busy ? '正在准备远程控制…' : loading ? '正在读取显示器…' : ''" />
        <button v-if="error" type="button" :disabled="busy || loading" @click="loadMonitors">重试</button>
        <button type="button" class="confirm-button" :disabled="busy || loading || !sourceId || Boolean(error)"
          @click="emit('allow', sourceId, publicVideo)">接受并共享</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.remote-request-card { width: min(520px, calc(100vw - 40px)); padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); display: grid; gap: 12px; }
.remote-request-card h2 { margin: 0; font-size: 22px; line-height: 32px; }
.remote-request-card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 20px; }
.remote-public-option { display: flex; align-items: center; gap: 8px; }
.remote-scope-note { min-height: 40px; }
.remote-request-card .card-actions { display: flex; align-items: center; gap: 8px; }
.remote-request-card .inline-feedback { flex: 1; }
@media (max-width: 520px) { .remote-request-card { padding: 20px; } .remote-request-card .card-actions { flex-wrap: wrap; } .remote-request-card .inline-feedback { flex-basis: 100%; order: -1; } .confirm-button { margin-left: auto; } }
</style>
