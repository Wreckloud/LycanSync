<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { readScreenSharePreferences, saveScreenSharePreferences } from '../../settings/screenSharePreferences';
import InlineFeedback from '../InlineFeedback.vue';
import UpdateRestartDialog from '../UpdateRestartDialog.vue';
import { useClientUpdate } from '../../settings/useClientUpdate';

const props = defineProps<{ desktop: boolean; active: boolean; stageAutoFill: boolean; stagePreferenceError: string }>();
const emit = defineEmits<{ stageAutoFill: [enabled: boolean] }>();
const autoStartSupported = ref<boolean>();
const autoStartEnabled = ref(false);
const autoStartBusy = ref(false);
const autoStartError = ref('');
const desktopBridge = window.lycanDesktop;
let loaded = false;
const screenPreferences = reactive({ hideCursor: false, hideBorder: false });
const screenSupport = ref<{ hideCursor: boolean; hideBorder: boolean }>();
const screenError = ref('');
const { state: updateState, error: updateError, busy: updateBusy, confirmationVersion,
  check: checkUpdates, cancel: cancelUpdate, restart: restartUpdate } = useClientUpdate(desktopBridge,
  () => props.active && props.desktop);
let screenLoaded = false;
const confirmingUpdate = computed(() => Boolean(confirmationVersion.value));
const borderDescription = computed(() => {
  if (!screenSupport.value) return screenError.value ? '尚未确认系统支持情况。' : '正在确认系统支持情况…';
  return screenSupport.value.hideBorder
    ? '需要 Windows 授权及安装包权限支持；未获准时会提示，其他应用也可能要求保留边框。'
    : '需要 Windows build 20348 或以上；当前系统无法通过官方接口隐藏边框。';
});
const autoStartDescription = computed(() => {
  if (autoStartSupported.value === undefined) return autoStartError.value ? '尚未确认开机自启支持情况。' : '正在读取开机自启设置…';
  return autoStartSupported.value
    ? '使用 Windows 登录项启动，不增加额外常驻进程。'
    : '仅 Windows 安装版支持，开发模式不会修改系统启动项。';
});

// 弹窗通过 Teleport 展示；由设置页隔离背景，避免确认期间切栏或返回。
defineExpose({ confirmingUpdate });

watch(() => [props.active, props.desktop] as const, ([active, desktop]) => {
  if (!active || !desktop || screenLoaded) return;
  screenLoaded = true;
  try {
    Object.assign(screenPreferences, readScreenSharePreferences());
  } catch {
    screenError.value = '无法读取屏幕共享设置，请重新保存。';
  }
  if (!desktopBridge?.getScreenShareSupport) {
    screenError.value = '请重新启动客户端以读取屏幕共享设置支持情况。';
    return;
  }
  void desktopBridge.getScreenShareSupport().then((support) => {
    screenSupport.value = support;
  }).catch(() => { screenError.value = '无法确认屏幕共享设置支持情况，请重新打开客户端。'; });
}, { immediate: true });

function updateScreenPreference(key: 'hideCursor' | 'hideBorder', event: Event) {
  if (!screenSupport.value?.[key]) return;
  const input = event.target as HTMLInputElement;
  const previous = screenPreferences[key];
  screenPreferences[key] = input.checked;
  try {
    saveScreenSharePreferences(screenPreferences);
    screenError.value = '';
  } catch {
    screenPreferences[key] = previous;
    // 同步回退可能与上次渲染值相同，仍须恢复用户刚改变的原生勾选状态。
    input.checked = previous;
    screenError.value = '无法保存屏幕共享设置。';
  }
}

watch(() => [props.active, props.desktop] as const, ([active, desktop]) => {
  if (!active || !desktop || loaded) return;
  loaded = true;
  if (!desktopBridge?.getAutoStart) {
    autoStartError.value = '请重新启动客户端以读取开机自启设置。';
    return;
  }
  void desktopBridge.getAutoStart().then((settings) => {
    autoStartSupported.value = settings.supported;
    autoStartEnabled.value = settings.enabled;
  }).catch(() => { autoStartError.value = '无法读取开机自启设置'; });
}, { immediate: true });

async function updateAutoStart(event: Event) {
  if (autoStartBusy.value || !autoStartSupported.value || !desktopBridge) return;
  const enabled = (event.target as HTMLInputElement).checked;
  const previous = autoStartEnabled.value;
  autoStartEnabled.value = enabled;
  autoStartBusy.value = true;
  autoStartError.value = '';
  try {
    const settings = await desktopBridge.setAutoStart(enabled);
    if (!settings?.supported) throw new Error('当前版本不支持开机自启');
    autoStartEnabled.value = settings.enabled;
  } catch (exception) {
    autoStartEnabled.value = previous;
    autoStartError.value = exception instanceof Error ? exception.message : '无法修改开机自启设置';
  } finally {
    autoStartBusy.value = false;
  }
}
</script>

<template>
  <div class="settings-section client-settings">
    <p class="settings-intro">客户端选项只影响当前设备。</p>
    <section v-if="desktop" class="settings-block">
      <h2>应用更新</h2>
      <div class="settings-toggle update-summary">
        <span><strong>版本 {{ updateState?.version || '读取中…' }}</strong><small>启动时自动检查；也可手动检查并确认重启更新。</small></span>
        <button type="button" class="settings-button" :disabled="updateBusy || !updateState?.supported || updateState.phase === 'checking'" @click="checkUpdates">{{ updateBusy || updateState?.phase === 'checking' ? '正在检查…' : '检查更新' }}</button>
      </div>
      <InlineFeedback :message="confirmationVersion ? '' : updateError || (updateState?.error ? updateState.message : '')"
        :status="updateState?.error ? '' : updateState?.message" />
      <UpdateRestartDialog v-if="confirmationVersion" :version="confirmationVersion" :busy="updateBusy" :error="updateError"
        @cancel="cancelUpdate" @confirm="restartUpdate" />
    </section>
    <section class="settings-block">
      <h2>共享观看</h2>
      <label class="settings-toggle">
        <span><strong>自动填充舞台</strong><small>按开始共享的顺序填入最多四路；停止共享或移出后自动补位。手动移出的画面不会自动返回。</small></span>
        <input type="checkbox" :checked="stageAutoFill" aria-label="自动填充舞台"
          @change="emit('stageAutoFill', ($event.target as HTMLInputElement).checked)" />
      </label>
      <InlineFeedback :message="stagePreferenceError" />
    </section>
    <section class="settings-block">
      <h2>屏幕共享</h2>
      <p>以下设置在下一次屏幕共享时生效。</p>
      <p v-if="!desktop">浏览器版由浏览器管理光标和共享边框，以下选项仅适用于桌面版。</p>
      <template v-else>
        <label class="settings-toggle" :class="{ 'is-disabled': !screenSupport?.hideCursor }">
          <span><strong>隐藏共享画面中的光标</strong><small>只隐藏发送给其他成员的光标，不影响本机鼠标。需要 Windows 10 build 19041 或以上。</small></span>
          <input type="checkbox" :checked="screenPreferences.hideCursor" :disabled="!screenSupport?.hideCursor"
            aria-label="隐藏共享画面中的光标" @change="updateScreenPreference('hideCursor', $event)" />
        </label>
        <label class="settings-toggle" :class="{ 'is-disabled': !screenSupport?.hideBorder }">
          <span><strong>隐藏黄色共享边框</strong><small>{{ borderDescription }}</small></span>
          <input type="checkbox" :checked="screenPreferences.hideBorder" :disabled="!screenSupport?.hideBorder"
            aria-label="隐藏黄色共享边框" @change="updateScreenPreference('hideBorder', $event)" />
        </label>
        <InlineFeedback :message="screenError" />
      </template>
    </section>
    <section class="settings-block">
      <h2>系统</h2>
      <p v-if="!desktop">开机自启仅在 Windows 桌面版提供。</p>
      <label v-else class="settings-toggle" :class="{ 'is-disabled': !autoStartSupported || autoStartBusy }">
        <span><strong>开机自动启动</strong><small>{{ autoStartDescription }}</small></span>
        <input type="checkbox" :checked="autoStartEnabled" :disabled="!autoStartSupported || autoStartBusy"
          aria-label="开机自动启动" @change="updateAutoStart" />
      </label>
      <InlineFeedback :message="autoStartError" />
    </section>
  </div>
</template>

<style scoped>
.client-settings { max-width: 760px; }
.update-summary { cursor: default; }
.update-summary > button { flex-shrink: 0; }
</style>
