<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref } from 'vue';
import { Pencil, UsersRound } from '@lucide/vue';
import AvatarCropDialog from './AvatarCropDialog.vue';
import InlineFeedback from './InlineFeedback.vue';
import { useAvatarCrop } from '../profile/useAvatarCrop';

const props = defineProps<{ createGroup: (name: string, description: string, avatar: string) => Promise<void> }>();
const emit = defineEmits<{ close: [] }>();
const name = ref('');
const description = ref('');
const avatar = ref('');
const avatarInput = ref<HTMLInputElement | null>(null);
const avatarButton = ref<HTMLButtonElement | null>(null);
const dialog = ref<HTMLFormElement | null>(null);
const busy = ref(false);
const error = ref('');
const { cropSource, picking, pickAvatar, clearCrop } = useAvatarCrop(error);
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

function close() {
  if (!busy.value && !cropSource.value) emit('close');
}

async function finishCrop(value?: string) {
  if (value !== undefined) avatar.value = value;
  clearCrop();
  await nextTick();
  avatarButton.value?.focus();
}

async function submit() {
  if (busy.value || picking.value || cropSource.value || !name.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    await props.createGroup(name.value.trim(), description.value.trim(), avatar.value);
  } catch (exception) {
    error.value = exception instanceof Error ? exception.message : '创建群组失败，请重试。';
  } finally {
    busy.value = false;
  }
}

function keepFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value) return;
  const controls = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), textarea:not(:disabled)')];
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

onMounted(() => dialog.value?.focus());
onScopeDispose(() => { if (returnFocus?.isConnected) returnFocus.focus(); });
</script>

<template>
  <div class="dialog-backdrop" @keydown.esc.stop="close">
    <form ref="dialog" class="group-entry" role="dialog" aria-modal="true" aria-label="创建群组" tabindex="-1"
      :inert="!!cropSource" @submit.prevent="submit" @keydown="keepFocus">
      <header class="entry-header">
        <div><h2>创建群组</h2><p>让朋友们有个相聚的地方</p></div>
      </header>
      <div class="entry-body">
        <div class="entry-identity">
          <div class="entry-avatar-area">
            <button ref="avatarButton" type="button" class="group-avatar-preview" aria-label="选择群组头像"
              :disabled="busy || picking" @click="avatarInput?.click()">
              <img v-if="avatar" :src="avatar" alt="群组头像预览" />
              <UsersRound v-else :size="32" />
              <span class="entry-avatar-overlay" aria-hidden="true"><Pencil :size="18" /><span>编辑</span></span>
            </button>
            <button type="button" class="entry-avatar-action" :disabled="busy || picking" @click="avatar ? avatar = '' : avatarInput?.click()">{{ avatar ? '移除' : '添加头像' }}</button>
          </div>
          <input ref="avatarInput" type="file" hidden aria-label="上传群组头像" accept="image/png,image/jpeg" @change="pickAvatar" />
          <label class="entry-field entry-name">群组名称
            <input v-model="name" aria-label="群组名称" required maxlength="32" autocomplete="off" :readonly="busy" placeholder="给小队起个名字" />
          </label>
        </div>
        <div class="entry-description">
          <div class="entry-field-heading">
            <label for="group-description">群组描述<span>选填</span></label>
            <span class="entry-count">{{ description.length }} / 200</span>
          </div>
          <textarea id="group-description" v-model="description" aria-label="群组描述（可选）"
            maxlength="200" rows="3" :readonly="busy" placeholder="常玩的游戏，或想和朋友一起做的事" />
        </div>
      </div>
      <footer class="entry-footer">
        <InlineFeedback class="entry-feedback" :message="error" :status="busy ? '正在创建…' : picking ? '正在读取图片…' : ''" />
        <div class="button-actions">
          <button type="button" :disabled="busy" @click="close">取消</button>
          <button type="submit" class="confirm-button" :disabled="busy || picking || !name.trim()">创建群组</button>
        </div>
      </footer>
    </form>
    <AvatarCropDialog v-if="cropSource" :source="cropSource" title="调整群组头像" @apply="finishCrop" @cancel="finishCrop()" />
  </div>
</template>

<style scoped>
.group-entry { width: min(480px, 100%); max-height: calc(100dvh - 36px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-soft); font-size: 14px; line-height: 20px; }
.entry-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.entry-header h2 { margin: 0; font-size: 22px; line-height: 32px; }
.entry-header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 20px; }
.entry-body { display: grid; gap: 20px; margin: 24px 0 20px; }
.entry-identity { display: flex; align-items: center; gap: 16px; height: 96px; }
.entry-avatar-area { position: relative; flex-shrink: 0; }
.group-avatar-preview { position: relative; display: grid; place-items: center; width: 72px; height: 72px; overflow: hidden; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-raised); color: var(--muted); cursor: pointer; }
.group-avatar-preview img { width: 100%; height: 100%; object-fit: cover; }
.entry-avatar-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; background: #0009; color: white; font-size: 12px; opacity: 0; }
.group-avatar-preview:hover .entry-avatar-overlay, .group-avatar-preview:focus-visible .entry-avatar-overlay { opacity: 1; }
.entry-avatar-action { position: absolute; top: 74px; width: 72px; padding: 0; border: 0; background: transparent; color: var(--muted); font-size: 12px; line-height: 18px; cursor: pointer; }
.entry-avatar-action:hover:not(:disabled) { color: var(--text); }
.entry-field { display: grid; gap: 4px; min-width: 0; }
.entry-name { flex: 1; }
.entry-name input { width: 100%; min-width: 0; height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 16px; }
.entry-name input:focus, .entry-description textarea:focus { border-color: var(--subtle); }
.entry-description { display: grid; gap: 4px; }
.entry-field-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; height: 20px; }
.entry-field-heading label { display: flex; align-items: baseline; gap: 6px; }
.entry-field-heading label span, .entry-count { color: var(--muted); font-size: 12px; }
.entry-description textarea { width: 100%; height: 88px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; line-height: 22px; }
.entry-description textarea { resize: none; }
.entry-footer { display: flex; align-items: center; gap: 12px; padding-top: 16px; border-top: 1px solid var(--border-soft); }
.entry-feedback { flex: 1; }
.entry-footer .button-actions { flex-shrink: 0; justify-content: flex-end; }
.entry-footer .confirm-button { border-color: var(--accent); background: var(--accent); }
@media (max-width: 420px) { .group-entry { padding: 20px; } .entry-header h2 { font-size: 20px; } .entry-identity { gap: 12px; } .group-avatar-preview, .entry-avatar-action { width: 64px; } .group-avatar-preview { height: 64px; } .entry-avatar-action { top: 66px; } }
</style>
