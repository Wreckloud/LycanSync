<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref } from 'vue';
import { ArrowRight, Link, Pencil, UsersRound } from '@lucide/vue';
import AvatarCropDialog from './AvatarCropDialog.vue';

const props = defineProps<{ createGroup: (name: string, description: string, avatar: string) => Promise<void> }>();
const emit = defineEmits<{ close: [] }>();
const mode = ref<'create' | 'join'>('create');
const name = ref('');
const description = ref('');
const avatar = ref('');
const invitationCode = ref('');
const cropFile = ref<File | null>(null);
const avatarInput = ref<HTMLInputElement | null>(null);
const avatarButton = ref<HTMLButtonElement | null>(null);
const dialog = ref<HTMLFormElement | null>(null);
const busy = ref(false);
const error = ref('');
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
const creating = computed(() => mode.value === 'create');
const title = computed(() => creating.value ? '创建群组' : '加入群组');

function close() {
  if (!busy.value && !cropFile.value) emit('close');
}

function switchMode() {
  if (busy.value || cropFile.value) return;
  mode.value = creating.value ? 'join' : 'create';
  error.value = '';
}

function pickAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  cropFile.value = input.files?.[0] ?? null;
  input.value = '';
  error.value = '';
}

async function finishCrop(value?: string) {
  if (value !== undefined) avatar.value = value;
  cropFile.value = null;
  await nextTick();
  avatarButton.value?.focus();
}

async function submit() {
  // 加入页仅用于布局预览，不能落入创建请求或伪报加入成功。
  if (!creating.value || busy.value || cropFile.value || !name.value.trim()) return;
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
    <form ref="dialog" class="group-entry" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1"
      :inert="!!cropFile" @submit.prevent="submit" @keydown="keepFocus">
      <header class="entry-header">
        <div><h2>{{ title }}</h2><p>{{ creating ? '让朋友们有个相聚的地方' : '找到你的开黑小队' }}</p></div>
        <button type="button" class="entry-switch" :disabled="busy" @click="switchMode">
          {{ creating ? '加入群组' : '创建群组' }}<ArrowRight :size="16" aria-hidden="true" />
        </button>
      </header>
      <div class="entry-body">
        <div class="entry-identity">
          <div class="entry-avatar-area">
            <button v-if="creating" ref="avatarButton" type="button" class="group-avatar-preview" aria-label="选择群组头像"
              :disabled="busy" @click="avatarInput?.click()">
              <img v-if="avatar" :src="avatar" alt="群组头像预览" />
              <UsersRound v-else :size="32" />
              <span class="entry-avatar-overlay" aria-hidden="true"><Pencil :size="18" /><span>编辑</span></span>
            </button>
            <div v-else class="group-avatar-preview entry-join-icon" aria-hidden="true"><Link :size="32" /></div>
            <button v-if="creating && avatar" type="button" class="entry-remove-avatar" :disabled="busy" @click="avatar = ''">移除</button>
          </div>
          <input ref="avatarInput" type="file" hidden aria-label="上传群组头像" accept="image/png,image/jpeg" @change="pickAvatar" />
          <label v-if="creating" class="entry-field entry-name">群组名称
            <input v-model="name" aria-label="群组名称" required maxlength="32" autocomplete="off" :readonly="busy" placeholder="给小队起个名字" />
          </label>
          <label v-else class="entry-field entry-name">群组邀请码
            <input v-model="invitationCode" aria-label="群组邀请码" autocomplete="off" placeholder="输入群组邀请码" />
          </label>
        </div>
        <div class="entry-description">
          <div class="entry-field-heading">
            <label :for="creating ? 'group-description' : undefined">{{ creating ? '群组描述' : '加入方式' }}<span v-if="creating">选填</span></label>
            <span v-if="creating" class="entry-count">{{ description.length }} / 200</span>
          </div>
          <textarea v-if="creating" id="group-description" v-model="description" aria-label="群组描述（可选）"
            maxlength="200" rows="3" :readonly="busy" placeholder="常玩的游戏，或想和朋友一起做的事" />
          <div v-else class="entry-join-placeholder"><strong>加入功能暂未开放</strong><span>暂不验证或提交邀请码。</span></div>
        </div>
      </div>
      <footer class="entry-footer">
        <div class="entry-feedback"><p v-if="error" role="alert">{{ error }}</p><span v-else-if="busy" role="status">正在创建…</span></div>
        <div class="button-actions">
          <button type="button" :disabled="busy" @click="close">取消</button>
          <button type="submit" class="confirm-button" :disabled="!creating || busy || !name.trim()">{{ creating ? '创建群组' : '加入群组' }}</button>
        </div>
      </footer>
    </form>
    <AvatarCropDialog v-if="cropFile" :file="cropFile" title="调整群组头像" shape="rounded-square" @apply="finishCrop" @cancel="finishCrop()" />
  </div>
</template>

<style scoped>
.group-entry { width: min(480px, 100%); max-height: calc(100dvh - 36px); overflow-y: auto; padding: 24px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-soft); font-size: 14px; line-height: 20px; }
.entry-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.entry-header h2 { margin: 0; font-size: 22px; line-height: 32px; }
.entry-header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 20px; }
.entry-switch { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; height: var(--button-height); padding: 5px 0 5px 8px; border: 0; background: transparent; color: var(--muted); font-size: 14px; cursor: pointer; }
.entry-switch:hover:not(:disabled) { color: var(--text); }
.entry-body { display: grid; gap: 20px; margin: 24px 0 20px; }
.entry-identity { display: flex; align-items: center; gap: 16px; height: 96px; }
.entry-avatar-area { position: relative; flex-shrink: 0; }
.group-avatar-preview { position: relative; display: grid; place-items: center; width: 72px; height: 72px; overflow: hidden; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-raised); color: var(--muted); cursor: pointer; }
.group-avatar-preview img { width: 100%; height: 100%; object-fit: cover; }
.entry-join-icon { cursor: default; }
.entry-avatar-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; background: #0009; color: white; font-size: 12px; opacity: 0; }
.group-avatar-preview:hover .entry-avatar-overlay, .group-avatar-preview:focus-visible .entry-avatar-overlay { opacity: 1; }
.entry-remove-avatar { position: absolute; top: 74px; width: 72px; padding: 0; border: 0; background: transparent; color: var(--muted); font-size: 12px; line-height: 18px; cursor: pointer; }
.entry-remove-avatar:hover:not(:disabled) { color: var(--text); }
.entry-field { display: grid; gap: 4px; min-width: 0; }
.entry-name { flex: 1; }
.entry-name input { width: 100%; min-width: 0; height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 16px; }
.entry-name input:focus, .entry-description textarea:focus { border-color: var(--subtle); }
.entry-description { display: grid; gap: 4px; }
.entry-field-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; height: 20px; }
.entry-field-heading label { display: flex; align-items: baseline; gap: 6px; }
.entry-field-heading label span, .entry-count { color: var(--muted); font-size: 12px; }
.entry-description textarea, .entry-join-placeholder { width: 100%; height: 88px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; line-height: 22px; }
.entry-description textarea { resize: none; }
.entry-join-placeholder { display: flex; flex-direction: column; justify-content: center; gap: 4px; }
.entry-join-placeholder strong { font-size: 14px; font-weight: 500; }
.entry-join-placeholder span { color: var(--muted); font-size: 12px; }
.entry-footer { display: flex; align-items: center; gap: 12px; padding-top: 16px; border-top: 1px solid var(--border-soft); }
.entry-feedback { flex: 1; min-width: 0; height: 32px; overflow: auto; color: var(--muted); font-size: 12px; line-height: 16px; }
.entry-feedback p { margin: 0; color: var(--danger); }
.entry-footer .button-actions { flex-shrink: 0; justify-content: flex-end; }
.entry-footer .confirm-button { border-color: var(--accent); background: var(--accent); }
@media (max-width: 420px) { .group-entry { padding: 20px; } .entry-header h2 { font-size: 20px; } .entry-identity { gap: 12px; } .group-avatar-preview, .entry-remove-avatar { width: 64px; } .group-avatar-preview { height: 64px; } .entry-remove-avatar { top: 66px; } }
</style>
