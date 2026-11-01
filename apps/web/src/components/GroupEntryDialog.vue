<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { ArrowRight, Pencil, UsersRound } from '@lucide/vue';
import AvatarCropDialog from './AvatarCropDialog.vue';
import DialogTransition from './DialogTransition.vue';
import InlineFeedback from './InlineFeedback.vue';
import { joinGroupByCode, type GroupDetail } from '../group/groupApi';
import { useAvatarCrop } from '../profile/useAvatarCrop';
import { useBackdropDismiss } from './useBackdropDismiss';

const props = defineProps<{ createGroup: (name: string, description: string, avatar: string) => Promise<void>; group?: GroupDetail }>();
const emit = defineEmits<{ close: []; joined: [group: GroupDetail] }>();
const mode = ref<'create' | 'join'>('create');
let modeAnimation: Animation | undefined;
let modePreference: MediaQueryList | undefined;
let modeGeneration = 0;
const code = ref('');
const name = ref(props.group?.name ?? '');
const description = ref(props.group?.description ?? '');
const avatar = ref(props.group?.avatar ?? '');
const avatarInput = ref<HTMLInputElement | null>(null);
const dialog = ref<HTMLFormElement | null>(null);
const viewport = ref<HTMLElement | null>(null);
const modeStage = ref<HTMLElement | null>(null);
const busy = ref(false);
const backdropEvents = useBackdropDismiss(close);
const error = ref('');
const { cropSource, picking, pickAvatar, editAvatar, clearCrop } = useAvatarCrop(error);

function close() {
  if (!busy.value && !picking.value && !cropSource.value) emit('close');
}

function finishCrop(value?: string) {
  if (value !== undefined) avatar.value = value;
  clearCrop();
}

async function submit() {
  if (busy.value || picking.value || cropSource.value || (mode.value === 'join' ? !code.value.trim() : !name.value.trim())) return;
  busy.value = true;
  error.value = '';
  try {
    if (mode.value === 'join') emit('joined', await joinGroupByCode(code.value.trim()));
    else await props.createGroup(name.value.trim(), description.value.trim(), avatar.value);
  } catch (exception) {
    error.value = exception instanceof Error ? exception.message : '创建群组失败，请重试。';
  } finally {
    busy.value = false;
  }
}

function keepFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value) return;
  const controls = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), textarea:not(:disabled)')].filter((control) => control.getClientRects().length > 0 && !control.closest('[inert]'));
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

function retireMode(element: Element) {
  const page = element as HTMLElement;
  page.inert = true;
  // 退场字段仍短暂留在同一个 form 内，不能参与原生必填校验或再次提交。
  page.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button')
    .forEach((control) => { control.disabled = true; });
}

watch(mode, async () => {
  const stage = modeStage.value;
  if (!stage) return;
  const from = Number.parseFloat(getComputedStyle(stage).height);
  modeAnimation?.cancel();
  modeAnimation = undefined;
  // 只衔接内容区高度；标题、切换入口和操作区始终保留同一份 DOM。
  stage.style.height = `${from}px`;
  const generation = ++modeGeneration;
  await nextTick();
  if (generation !== modeGeneration || !viewport.value || modeStage.value !== stage) return;
  viewport.value.scrollTop = 0;
  const page = stage.querySelector<HTMLElement>('.entry-mode-page:not([inert])');
  if (!page) { stage.style.removeProperty('height'); return; }
  const style = getComputedStyle(stage);
  const to = Number.parseFloat(getComputedStyle(page).height);
  if (!modePreference?.matches && typeof stage.animate === 'function') {
    stage.style.height = `${to}px`;
    const animation = stage.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: Number.parseFloat(style.getPropertyValue('--motion-layout-duration')),
      easing: style.getPropertyValue('--motion-ease').trim(),
    });
    modeAnimation = animation;
    animation.finished.then(() => {
      if (modeAnimation !== animation) return;
      modeAnimation = undefined;
      stage.style.removeProperty('height');
    }, () => {});
  } else stage.style.removeProperty('height');
  page.querySelector<HTMLInputElement>('input:not([type="file"])')?.focus({ preventScroll: true });
});
function stopModeMotion() {
  modeAnimation?.cancel();
  modeAnimation = undefined;
  modeStage.value?.style.removeProperty('height');
}
function reduceModeMotion() { if (modePreference?.matches) stopModeMotion(); }
onScopeDispose(() => {
  modeGeneration++;
  stopModeMotion();
  modePreference?.removeEventListener('change', reduceModeMotion);
});
onMounted(() => {
  modePreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  modePreference.addEventListener('change', reduceModeMotion);
  dialog.value?.focus({ preventScroll: true });
});

</script>

<template>
  <div class="dialog-backdrop" v-on="backdropEvents" @keydown.esc.stop="close">
    <form ref="dialog" class="group-entry" role="dialog" aria-modal="true" tabindex="-1"
      :aria-label="group ? '编辑群组资料' : mode === 'join' ? '加入群组' : '创建群组'"
      :inert="!!cropSource" @submit.prevent="submit" @keydown="keepFocus">
      <div ref="viewport" class="entry-viewport">
      <header class="entry-header">
        <div><h2>{{ group ? '编辑群组资料' : mode === 'join' ? '加入群组' : '创建群组' }}</h2><p>{{ mode === 'join' ? '和熟悉的人相聚' : '让朋友们有个相聚的地方' }}</p></div>
        <button v-if="!group" type="button" class="card-header-action" :disabled="busy || picking || !!cropSource"
          @click="mode = mode === 'create' ? 'join' : 'create'; error = ''">{{ mode === 'create' ? '加入群聊' : '创建群聊' }}<ArrowRight :size="16" aria-hidden="true" /></button>
      </header>
      <div ref="modeStage" class="entry-mode-stage">
      <Transition name="entry-mode" @before-leave="retireMode">
      <div :key="mode" class="entry-mode-page">
      <div v-if="mode === 'create'" class="entry-body">
        <div class="entry-identity">
          <div class="entry-avatar-area">
            <button type="button" class="group-avatar-preview" aria-label="选择群组头像"
              :disabled="busy || picking" @click="avatar ? editAvatar(avatar) : avatarInput?.click()">
              <img v-if="avatar" :src="avatar" alt="群组头像预览" />
              <UsersRound v-else :size="32" />
              <span class="entry-avatar-overlay" aria-hidden="true"><Pencil :size="18" /><span>编辑</span></span>
            </button>
            <div class="avatar-actions">
              <button type="button" class="avatar-action" :disabled="busy || picking" @click="avatarInput?.click()">更换头像</button>
            </div>
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
      <div v-else class="entry-body entry-join-body">
        <label class="entry-field">群组邀请码<input v-model="code" aria-label="群组邀请码" maxlength="16" autocomplete="off" :readonly="busy" placeholder="输入群主提供的邀请码" /></label>
        <p>邀请码仅用于加入当前服务器的群组，不会连接语音。</p>
      </div>
      </div>
      </Transition>
      </div>
      <footer class="card-actions">
        <button type="button" class="settings-button" :disabled="busy || picking" @click="close">取消</button>
        <InlineFeedback class="card-feedback" :message="error" :status="busy ? (group ? '正在保存…' : mode === 'join' ? '正在加入…' : '正在创建…') : picking ? '正在读取图片…' : ''" />
        <button type="submit" class="confirm-button card-actions-end" :disabled="busy || picking || !!cropSource || (mode === 'join' ? !code.trim() : !name.trim())">{{ group ? '保存修改' : mode === 'join' ? '加入群组' : '创建群组' }}</button>
      </footer>
      </div>
    </form>
    <DialogTransition>
    <AvatarCropDialog v-if="cropSource" :source="cropSource" title="调整群组头像" shape="square" @apply="finishCrop" @cancel="finishCrop()" />
    </DialogTransition>
  </div>
</template>

<style scoped>
.group-entry { --entry-padding: 24px; width: min(480px, 100%); min-height: 0; max-height: calc(100dvh - 36px); overflow: clip; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-soft); font-size: 14px; line-height: 20px; }
.entry-viewport { position: relative; max-height: calc(100dvh - 38px); overflow-x: hidden; overflow-y: auto; padding: var(--entry-padding); scrollbar-width: none; }
.entry-viewport::-webkit-scrollbar { display: none; }
.entry-mode-stage { position: relative; overflow: clip; }
.entry-mode-page { display: flow-root; min-width: 0; }
.entry-mode-leave-active { position: absolute; inset: 0 0 auto; }
.entry-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.entry-body.entry-join-body { gap: 12px; align-content: start; }
.entry-join-body input { width: 100%; }
.entry-join-body p { margin: 0; color: var(--muted); font-size: 13px; }
.entry-header h2 { margin: 0; font-size: 22px; line-height: 32px; }
.entry-header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 20px; }
.entry-body { display: grid; gap: 20px; margin: 24px 0 20px; }
.entry-identity { position: relative; display: flex; align-items: center; gap: 16px; height: 96px; }
.entry-avatar-area { position: relative; flex-shrink: 0; }
.group-avatar-preview { position: relative; display: grid; place-items: center; width: 72px; height: 72px; overflow: hidden; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-raised); color: var(--muted); cursor: pointer; }
.group-avatar-preview img { width: 100%; height: 100%; object-fit: cover; }
.entry-avatar-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; background: #0009; color: white; font-size: 12px; opacity: 0; }
.group-avatar-preview:hover .entry-avatar-overlay, .group-avatar-preview:focus-visible .entry-avatar-overlay { opacity: 1; }
.entry-field { display: grid; gap: 4px; min-width: 0; }
.entry-name { flex: 1; }
.entry-field input { width: 100%; min-width: 0; height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 16px; }
.entry-name input:focus, .entry-description textarea:focus { border-color: var(--subtle); }
.entry-description { display: grid; gap: 4px; }
.entry-field-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; height: 20px; }
.entry-field-heading label { display: flex; align-items: baseline; gap: 6px; }
.entry-field-heading label span, .entry-count { color: var(--muted); font-size: 12px; }
.entry-description textarea { width: 100%; height: 88px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; line-height: 22px; }
.entry-description textarea { resize: none; }
@media (max-width: 420px) { .group-entry { --entry-padding: 20px; } .entry-header h2 { font-size: 20px; } .entry-identity { gap: 12px; } .group-avatar-preview { width: 64px; height: 64px; } }
</style>
