<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { uploadLimits, type UploadLimits } from '../../chat/chatApi';
import InlineFeedback from '../InlineFeedback.vue';

const props = defineProps<{ active: boolean; leaving: boolean }>();
const emit = defineEmits<{ notice: [message: string] }>();
const mib = 1024 ** 2;
const saved = ref<UploadLimits>();
const fileMiB = ref(0);
const storageGiB = ref(0);
const error = ref('');
const busy = ref(false);
let request: AbortController | undefined;
const changed = computed(() => fileMiB.value * mib !== saved.value?.maxFileBytes
  || storageGiB.value * mib * 1024 !== saved.value?.maxStorageBytes);

async function update(save = false) {
  request?.abort();
  const current = request = new AbortController();
  busy.value = true;
  error.value = '';
  try {
    const limits = await uploadLimits(current.signal, save ? {
      maxFileBytes: Math.round(fileMiB.value * mib), maxStorageBytes: Math.round(storageGiB.value * mib * 1024),
    } : undefined);
    if (current.signal.aborted) return;
    saved.value = limits;
    fileMiB.value = limits.maxFileBytes / mib;
    storageGiB.value = limits.maxStorageBytes / mib / 1024;
    if (save) emit('notice', '文件上传限额已保存');
  } catch (reason) {
    if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : '无法读取或保存文件上传限额';
  } finally {
    if (current === request) busy.value = false;
  }
}
watch(() => props.active, active => {
  if (active) void update();
  else request?.abort();
}, { immediate: true });
onScopeDispose(() => request?.abort());
</script>

<template>
  <form class="settings-block" @submit.prevent="update(true)">
    <h2>文件上传</h2>
    <template v-if="saved">
      <label class="settings-action-row"><strong>单个文件上限（MiB）</strong>
        <span class="settings-field settings-control"><input v-model.number="fileMiB" type="number" min="0.000001" step="any" required :disabled="busy || leaving" /></span>
      </label>
      <label class="settings-action-row"><strong>群聊文件总容量（GiB）</strong>
        <span class="settings-field settings-control"><input v-model.number="storageGiB" type="number" min="0.000001" step="any" required :disabled="busy || leaving" /></span>
      </label>
      <button type="submit" class="settings-button save-limits" :disabled="busy || leaving || !changed">保存限额</button>
    </template>
    <InlineFeedback :message="error" :pending="busy ? '正在同步上传限额…' : ''" />
    <button v-if="error && !saved" type="button" class="settings-button" @click="update()">重试</button>
  </form>
</template>

<style scoped>
.save-limits { justify-self: end; }
</style>
