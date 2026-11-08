<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { readScreenSharePreferences, saveScreenSharePreferences } from '../../settings/screenSharePreferences';
import InlineFeedback from '../InlineFeedback.vue';
import { useLoadingHint } from '../useLoadingHint';
import UpdateRestartDialog from '../UpdateRestartDialog.vue';
import DialogTransition from '../DialogTransition.vue';
import { useClientUpdate } from '../../settings/useClientUpdate';
import CacheSettings from './CacheSettings.vue';

const props = defineProps<{ desktop: boolean; active: boolean; userId?: string }>();
const cacheSettings = ref<InstanceType<typeof CacheSettings> | null>(null);
const confirmingCache = computed(() => Boolean(cacheSettings.value?.confirming));
const autoStartSupported = ref<boolean>();
const autoStartEnabled = ref(false);
const autoStartBusy = ref(false);
const autoStartError = ref('');
const traySupported = ref(false);
const closeToTray = ref(false);
const trayBusy = ref(false);
const trayError = ref('');
const desktopBridge = window.lycanDesktop;
let loaded = false;
let trayLoaded = false;
const screenPreferences = reactive({ hideCursor: false, hideBorder: true });
const screenSupport = ref<{ hideCursor: boolean; hideBorder: boolean }>();
const screenError = ref('');
const { state: updateState, error: updateError, busy: updateBusy, confirmationVersion,
  check: checkUpdates, cancel: cancelUpdate, restart: restartUpdate } = useClientUpdate(desktopBridge,
  () => props.active && props.desktop);
let screenLoaded = false;
const confirmingUpdate = computed(() => Boolean(confirmationVersion.value));
const updateLoadingHint = useLoadingHint(() => props.active && (updateBusy.value || updateState.value?.phase === 'checking'), 1000);
const autoStartLoadingHint = useLoadingHint(() => props.active && autoStartSupported.value === undefined && !autoStartError.value, 1000);
const updateDescription = computed(() => {
  if (updateBusy.value || updateState.value?.phase === 'checking') return updateLoadingHint.value ? '正在检查更新…' : '发现新版后，可确认重启更新。';
  if (!updateError.value && !updateState.value?.error && updateState.value?.message) return updateState.value.message;
  return '发现新版后，可确认重启更新。';
});
const autoStartDescription = computed(() => {
  if (autoStartSupported.value === undefined) return autoStartError.value ? '尚未确认开机自启支持情况。' : autoStartLoadingHint.value ? '正在读取开机自启设置…' : '随 Windows 登录自动启动客户端。';
  return autoStartSupported.value
    ? ''
    : '开机启动仅支持 Windows 安装版。';
});

// 弹窗通过 Teleport 展示；由设置页隔离背景，避免确认期间切栏或返回。
defineExpose({ confirmingUpdate, confirmingCache });

watch(() => [props.active, props.desktop] as const, ([active, desktop]) => {
  if (!active || !desktop || screenLoaded) return;
  screenLoaded = true;
  try {
    Object.assign(screenPreferences, readScreenSharePreferences());
  } catch {
    screenError.value = '无法读取屏幕共享设置，请重新保存。';
  }
  if (!desktopBridge?.getScreenShareSupport) {
    screenError.value = '暂时无法读取屏幕共享支持情况。';
    return;
  }
  void desktopBridge.getScreenShareSupport().then((support) => {
    screenSupport.value = support;
  }).catch(() => { screenError.value = '暂时无法确认屏幕共享支持情况。'; });
}, { immediate: true });

function updateScreenPreference(key: 'hideCursor', event: Event) {
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
    autoStartError.value = '暂时无法读取开机启动设置。';
    return;
  }
  void desktopBridge.getAutoStart().then((settings) => {
    autoStartSupported.value = settings.supported;
    autoStartEnabled.value = settings.enabled;
  }).catch(() => { autoStartError.value = '无法读取开机自启设置'; });
}, { immediate: true });

watch(() => [props.active, props.desktop] as const, ([active, desktop]) => {
  if (!active || !desktop || trayLoaded) return;
  trayLoaded = true;
  if (!desktopBridge?.getTraySettings) {
    trayError.value = '暂时无法读取托盘设置。';
    return;
  }
  void desktopBridge.getTraySettings().then((settings) => {
    traySupported.value = settings.supported;
    closeToTray.value = settings.enabled;
    trayError.value = settings.error;
  }).catch(() => { trayError.value = '无法读取托盘设置，请重新打开客户端。'; });
}, { immediate: true });

async function updateCloseToTray(event: Event) {
  if (trayBusy.value || !traySupported.value || !desktopBridge) return;
  const input = event.target as HTMLInputElement;
  const previous = closeToTray.value;
  closeToTray.value = input.checked;
  trayBusy.value = true;
  trayError.value = '';
  try {
    const settings = await desktopBridge.setCloseToTray(input.checked);
    closeToTray.value = settings.enabled;
    traySupported.value = settings.supported;
    trayError.value = settings.error;
  } catch (exception) {
    closeToTray.value = previous;
    input.checked = previous;
    trayError.value = exception instanceof Error ? exception.message : '无法保存托盘设置';
  } finally { trayBusy.value = false; }
}

async function updateAutoStart(event: Event) {
  if (autoStartBusy.value || !autoStartSupported.value || !desktopBridge) return;
  const input = event.target as HTMLInputElement;
  const enabled = input.checked;
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
    input.checked = previous;
    autoStartError.value = exception instanceof Error ? exception.message : '无法修改开机自启设置';
  } finally {
    autoStartBusy.value = false;
  }
}
</script>

<template>
  <div class="settings-section client-settings">
    <CacheSettings v-if="userId" ref="cacheSettings" :user-id="userId" :active="active" />
    <section v-if="desktop" class="settings-block">
      <h2>应用更新</h2>
      <div class="settings-toggle update-summary">
        <span><strong>{{ updateState?.version ? `版本 ${updateState.version}` : '客户端版本' }}</strong><small role="status">{{ updateDescription }}</small></span>
        <button type="button" class="settings-button" :disabled="updateBusy || !updateState?.supported || updateState.phase === 'checking'" @click="checkUpdates()">检查更新</button>
      </div>
      <InlineFeedback :message="confirmationVersion ? '' : updateError || (updateState?.error ? updateState.message : '')" />
      <DialogTransition>
      <UpdateRestartDialog v-if="confirmationVersion" :version="confirmationVersion" :busy="updateBusy" :error="updateError"
        @cancel="cancelUpdate" @confirm="restartUpdate" />
      </DialogTransition>
    </section>
    <section class="settings-block">
      <h2>屏幕共享</h2>
      <p>以下设置在下一次屏幕共享时生效。</p>
      <p v-if="!desktop">浏览器版由浏览器管理光标和共享边框，以下选项仅适用于桌面版。</p>
      <template v-else>
        <label class="settings-toggle" :class="{ 'is-disabled': !screenSupport?.hideCursor }">
          <span><strong>隐藏共享画面中的光标</strong><small>不向观看者显示光标，你仍能看到自己的鼠标。需要 Windows 10 build 19041 或以上。</small></span>
          <input type="checkbox" :checked="screenPreferences.hideCursor" :disabled="!screenSupport?.hideCursor"
            aria-label="隐藏共享画面中的光标" @change="updateScreenPreference('hideCursor', $event)" />
        </label>
        <p>共享窗口时会尽量隐藏系统边框；受系统或权限限制时仍可能显示。</p>
        <InlineFeedback :message="screenError" />
      </template>
    </section>
    <section class="settings-block">
      <h2>系统</h2>
      <p v-if="!desktop">托盘和开机自启仅在 Windows 桌面版提供。</p>
      <template v-else>
        <label class="settings-toggle" :class="{ 'is-disabled': !autoStartSupported || autoStartBusy }">
          <span><strong>开机自动启动</strong><small v-if="autoStartDescription">{{ autoStartDescription }}</small></span>
          <input type="checkbox" :checked="autoStartEnabled" :disabled="!autoStartSupported || autoStartBusy"
            aria-label="开机自动启动" @change="updateAutoStart" />
        </label>
        <InlineFeedback :message="autoStartError" />
        <label class="settings-toggle" :class="{ 'is-disabled': !traySupported || trayBusy }">
          <span><strong>关闭时收起到托盘</strong><small>关闭主窗口后继续通话、共享和录制；右键托盘选择“退出”结束应用。</small></span>
          <input type="checkbox" :checked="closeToTray" :disabled="!traySupported || trayBusy"
            aria-label="关闭时收起到托盘" @change="updateCloseToTray" />
        </label>
        <InlineFeedback :message="trayError" />
      </template>
    </section>
  </div>
</template>

<style scoped>
.update-summary { cursor: default; }
.update-summary > button { flex-shrink: 0; }
</style>
