<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { clearLocalContentCache, getLocalContentCacheUsage } from '../../cache/localCache';
import InlineFeedback from '../InlineFeedback.vue';

const props = defineProps<{ userId: string; active: boolean }>();
const usage = ref<{ current: number; total: number } | null>(null);
const loading = ref(false);
const clearing = ref(false);
const error = ref('');
const status = ref('');
const scope = ref<'current' | 'all'>('current');
const confirmation = ref<HTMLDialogElement | null>(null);
const confirming = ref(false);
let revision = 0;
let disposed = false;
const currentSize = computed(() => usage.value ? size(usage.value.current) : '—');
const totalSize = computed(() => usage.value ? size(usage.value.total) : '—');
defineExpose({ confirming });

function size(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}
async function refresh() {
  const current = ++revision;
  loading.value = true;
  try {
    const [account, all] = await Promise.all([getLocalContentCacheUsage(props.userId), getLocalContentCacheUsage()]);
    if (!disposed && revision === current) { usage.value = { current: account.bytes, total: all.bytes }; error.value = ''; }
  } catch {
    if (!disposed && revision === current) { usage.value = null; error.value = '无法读取缓存大小，请重试。'; }
  } finally { if (!disposed && revision === current) loading.value = false; }
}
function askToClear() {
  if (clearing.value || !props.active) return;
  error.value = ''; status.value = '';
  confirmation.value?.showModal();
  confirming.value = true;
}
function cancel(event?: Event) {
  if (clearing.value) { event?.preventDefault(); return; }
  confirmation.value?.close();
  confirming.value = false;
}
async function clear() {
  if (clearing.value || !confirming.value || !props.userId) return;
  clearing.value = true; error.value = ''; status.value = '';
  try {
    await clearLocalContentCache(scope.value === 'current' ? props.userId : undefined);
    if (disposed) return;
    confirmation.value?.close(); confirming.value = false;
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
onScopeDispose(() => { disposed = true; revision++; confirmation.value?.close(); });
</script>

<template>
  <section class="settings-block cache-settings">
    <h2>本地缓存</h2>
    <p>缓存可加快聊天内容、成员资料和图片的加载。</p>
    <div class="cache-size"><span>当前账号 {{ currentSize }} · 本机合计 {{ totalSize }}</span>
      <button type="button" class="settings-button" :disabled="loading || clearing" @click="refresh">刷新大小</button></div>
    <div class="cache-actions">
      <label>清理范围<select v-model="scope" aria-label="缓存清理范围" :disabled="clearing || confirming">
        <option value="current">当前账号</option><option value="all">本机全部账号与服务器</option>
      </select></label>
      <button type="button" class="settings-button" :disabled="clearing" @click="askToClear">清理缓存</button>
    </div>
    <small>只清理内容副本，不影响登录、服务器上的聊天记录、下载文件和录像。显示大小为内容估算。</small>
    <InlineFeedback :message="confirming ? '' : error" :status="status" :pending="loading ? '正在读取缓存大小…' : ''" />
    <dialog ref="confirmation" class="cache-confirm" aria-labelledby="cache-confirm-title" aria-describedby="cache-confirm-description" @cancel="cancel">
      <h2 id="cache-confirm-title">清理{{ scope === 'current' ? '当前账号' : '本机全部' }}缓存？</h2>
      <p id="cache-confirm-description">{{ scope === 'all' ? '包含本机其他账号与服务器留下的内容副本。' : '' }}下次查看时会重新加载，不影响登录和服务器上的聊天记录。</p>
      <footer class="card-actions">
        <button type="button" :disabled="clearing" @click="cancel()">取消</button>
        <InlineFeedback class="card-feedback" :message="error" :pending="clearing ? '正在清理缓存…' : ''" />
        <button type="button" class="confirm-button card-actions-end" :disabled="clearing" @click="clear">清理缓存</button>
      </footer>
    </dialog>
  </section>
</template>

<style scoped>
.cache-size, .cache-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cache-actions label { display: flex; align-items: center; gap: 12px; }
.cache-confirm { width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); }
.cache-confirm::backdrop { background: rgb(0 0 0 / 65%); }
.cache-confirm p { margin: 16px 0; line-height: 1.6; }
</style>
