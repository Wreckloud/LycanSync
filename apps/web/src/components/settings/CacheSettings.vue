<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { clearLocalContentCache, getLocalContentCacheUsage } from '../../cache/localCache';
import InlineFeedback from '../InlineFeedback.vue';
import DialogTransition from '../DialogTransition.vue';
import { keepDialogFocus } from '../dialogFocus';
import { useBackdropDismiss } from '../useBackdropDismiss';

const props = defineProps<{ userId: string; active: boolean }>();
const usage = ref<number | null>(null);
const loading = ref(false);
const clearing = ref(false);
const error = ref('');
const status = ref('');
const confirmation = ref<HTMLElement | null>(null);
const confirming = ref(false);
const backdropEvents = useBackdropDismiss(cancel);
let revision = 0;
let disposed = false;
const totalSize = computed(() => usage.value !== null ? size(usage.value) : '—');
defineExpose({ confirming });

function size(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}
async function refresh() {
  const current = ++revision;
  loading.value = true;
  try {
    const total = await getLocalContentCacheUsage();
    if (!disposed && revision === current) { usage.value = total.bytes; error.value = ''; }
  } catch {
    if (!disposed && revision === current) { usage.value = null; error.value = '无法读取缓存大小，请重新打开此页面。'; }
  } finally { if (!disposed && revision === current) loading.value = false; }
}
async function askToClear() {
  if (clearing.value || !props.active) return;
  error.value = ''; status.value = '';
  confirming.value = true;
  await nextTick();
  if (confirming.value) confirmation.value?.focus({ preventScroll: true });
}
function cancel() {
  if (clearing.value) return;
  confirming.value = false;
}
async function clear() {
  if (clearing.value || !confirming.value || !props.userId) return;
  clearing.value = true; error.value = ''; status.value = '';
  try {
    await clearLocalContentCache();
    if (disposed) return;
    confirming.value = false;
    status.value = '缓存已清理，之后查看的内容会按需重新缓存。';
    await refresh();
  } catch {
    if (!disposed) error.value = '缓存未能清理，请重试。';
  } finally { if (!disposed) clearing.value = false; }
}
watch(() => props.active, active => {
  if (active) { status.value = ''; void refresh(); }
  else if (!clearing.value) { revision++; loading.value = false; cancel(); }
}, { immediate: true });
onScopeDispose(() => { disposed = true; revision++; });
</script>

<template>
  <section class="settings-block cache-settings">
    <h2>本地缓存</h2>
    <p>缓存可加快聊天内容、成员资料和图片的加载。</p>
    <div class="cache-size"><span>本机缓存约 {{ totalSize }}</span>
      <button type="button" class="settings-button" :disabled="clearing" @click="askToClear">清理缓存</button></div>
    <small>只清理内容副本，不影响登录、服务器上的聊天记录、下载文件和录像。显示大小为内容估算。</small>
    <InlineFeedback :message="confirming ? '' : error" :status="status" :pending="loading ? '正在读取缓存大小…' : ''" />
    <DialogTransition>
      <div v-if="confirming" class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="cancel">
        <section ref="confirmation" class="cache-confirm" role="dialog" aria-modal="true" tabindex="-1"
          aria-labelledby="cache-confirm-title" aria-describedby="cache-confirm-description" @keydown="keepDialogFocus">
          <h2 id="cache-confirm-title">清理本机缓存？</h2>
          <p id="cache-confirm-description">将清理本机全部账号与服务器的内容缓存。下次查看时会重新加载，不影响登录和服务器上的聊天记录。</p>
          <footer class="card-actions">
            <button type="button" :disabled="clearing" @click="cancel()">取消</button>
            <InlineFeedback class="card-feedback" :message="error" :pending="clearing ? '正在清理缓存…' : ''" />
            <button type="button" class="confirm-button card-actions-end" :disabled="clearing" @click="clear">清理缓存</button>
          </footer>
        </section>
      </div>
    </DialogTransition>
  </section>
</template>

<style scoped>
.cache-size { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cache-confirm { width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); }
.cache-confirm p { margin: 16px 0; line-height: 1.6; }
</style>
