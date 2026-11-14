<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import InlineFeedback from '../InlineFeedback.vue';
import ProjectAttribution from '../ProjectAttribution.vue';
import { useLoadingHint } from '../useLoadingHint';
import UpdateRestartDialog from '../UpdateRestartDialog.vue';
import DialogTransition from '../DialogTransition.vue';
import { useClientUpdate } from '../../settings/useClientUpdate';
import CacheSettings from './CacheSettings.vue';
import DiagnosticReportSettings from './DiagnosticReportSettings.vue';
import type { Room } from 'livekit-client';
import type { useDiagnosticReport } from '../../diagnostics/useDiagnosticReport';
import packageInfo from '../../../package.json';

const props = defineProps<{ desktop: boolean; active: boolean; userId?: string; room: Room | null; report: ReturnType<typeof useDiagnosticReport> }>();
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
const { state: updateState, error: updateError, busy: updateBusy, confirmationVersion,
  check: checkUpdates, cancel: cancelUpdate, restart: restartUpdate } = useClientUpdate(desktopBridge,
  () => props.active && props.desktop);
const confirmingUpdate = computed(() => Boolean(confirmationVersion.value));
const updateLoadingHint = useLoadingHint(() => props.active && (updateBusy.value || updateState.value?.phase === 'checking'), 1000);
const autoStartLoadingHint = useLoadingHint(() => props.active && autoStartSupported.value === undefined && !autoStartError.value, 1000);
const updateDescription = computed(() => {
  if (updateBusy.value || updateState.value?.phase === 'checking') return updateLoadingHint.value ? '正在检查更新…' : '查看并安装新版本。';
  if (!updateError.value && !updateState.value?.error && updateState.value?.message) return updateState.value.message;
  return '查看并安装新版本。';
});
const autoStartDescription = computed(() => {
  if (autoStartSupported.value === undefined) return autoStartError.value ? '尚未确认开机自启支持情况。' : autoStartLoadingHint.value ? '正在读取开机自启设置…' : '登录 Windows 后自动启动。';
  return autoStartSupported.value
    ? '登录 Windows 后自动启动。'
    : '开机启动仅支持 Windows 安装版。';
});

// 弹窗通过 Teleport 展示；由设置页隔离背景，避免确认期间切栏或返回。
defineExpose({ confirmingUpdate, confirmingCache });

watch(() => [props.active, props.desktop] as const, ([active, desktop]) => {
  if (!active || !desktop || loaded) return;
  loaded = true;
  autoStartError.value = '';
  if (!desktopBridge?.getAutoStart) {
    loaded = false;
    autoStartError.value = '暂时无法读取开机启动设置。';
    return;
  }
  void desktopBridge.getAutoStart().then((settings) => {
    autoStartSupported.value = settings.supported;
    autoStartEnabled.value = settings.enabled;
  }).catch(() => { loaded = false; autoStartError.value = '无法读取开机自启设置，请重新进入此页面重试。'; });
}, { immediate: true });

watch(() => [props.active, props.desktop] as const, ([active, desktop]) => {
  if (!active || !desktop || trayLoaded) return;
  trayLoaded = true;
  trayError.value = '';
  if (!desktopBridge?.getTraySettings) {
    trayLoaded = false;
    trayError.value = '暂时无法读取托盘设置。';
    return;
  }
  void desktopBridge.getTraySettings().then((settings) => {
    traySupported.value = settings.supported;
    closeToTray.value = settings.enabled;
    trayError.value = settings.error;
    trayLoaded = !settings.error;
  }).catch(() => { trayLoaded = false; trayError.value = '无法读取托盘设置，请重新进入此页面重试。'; });
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
    <section class="settings-block">
      <h2>应用信息</h2>
      <div class="settings-toggle update-summary">
        <span><strong>lycanclaw · {{ updateState?.version || packageInfo.version }}</strong><small role="status">{{ desktop ? updateDescription : '浏览器版随服务器更新。' }}</small></span>
        <button v-if="desktop" type="button" class="settings-button settings-control" :disabled="updateBusy || !updateState?.supported || updateState.phase === 'checking'" @click="checkUpdates()">检查更新</button>
      </div>
      <ProjectAttribution>由 Wreckloud 设计与维护，GPT / OpenAI Codex 协助开发、测试与代码审查。<br />图标由 <a href="https://space.bilibili.com/303103435" target="_blank" rel="noopener noreferrer">@Airthead</a> 设计。</ProjectAttribution>
      <InlineFeedback :message="confirmationVersion ? '' : updateError || (updateState?.error ? updateState.message : '')" />
      <DialogTransition>
      <UpdateRestartDialog v-if="confirmationVersion" :version="confirmationVersion" :busy="updateBusy" :error="updateError"
        @cancel="cancelUpdate" @confirm="restartUpdate" />
      </DialogTransition>
    </section>
    <section class="settings-block">
      <h2>系统设置</h2>
      <p v-if="!desktop">托盘和开机自启仅在 Windows 桌面版提供。</p>
      <div v-else class="settings-toggle-group">
        <div class="settings-toggle" :class="{ 'is-disabled': !autoStartSupported || autoStartBusy }">
          <span><strong>开机自动启动</strong><small v-if="autoStartDescription">{{ autoStartDescription }}</small></span>
          <input type="checkbox" :checked="autoStartEnabled" :disabled="!autoStartSupported || autoStartBusy"
            aria-label="开机自动启动" @change="updateAutoStart" />
        </div>
        <InlineFeedback :message="autoStartError" />
        <div class="settings-toggle" :class="{ 'is-disabled': !traySupported || trayBusy }">
          <span><strong>关闭时收起到托盘</strong><small>关闭窗口后继续通话、共享和录制；从托盘菜单退出应用。</small></span>
          <input type="checkbox" :checked="closeToTray" :disabled="!traySupported || trayBusy"
            aria-label="关闭时收起到托盘" @change="updateCloseToTray" />
        </div>
        <InlineFeedback :message="trayError" />
      </div>
    </section>
    <DiagnosticReportSettings :report="report" :room="room" :active="active" />
    <CacheSettings v-if="userId" ref="cacheSettings" :user-id="userId" :active="active" />
  </div>
</template>

<style scoped>
.update-summary { cursor: default; }
.update-summary > button { flex-shrink: 0; }
</style>
