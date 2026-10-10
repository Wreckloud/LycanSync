<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { readScreenSharePreferences, saveScreenSharePreferences } from '../../settings/screenSharePreferences';

const props = defineProps<{ desktop: boolean; active: boolean; stageAutoFill: boolean; stagePreferenceError: string }>();
const emit = defineEmits<{ stageAutoFill: [enabled: boolean] }>();
const autoStartSupported = defineModel<boolean>('supported', { default: false });
const autoStartEnabled = defineModel<boolean>('enabled', { default: false });
const autoStartBusy = defineModel<boolean>('busy', { default: false });
const autoStartError = defineModel<string>('error', { default: '' });
const desktopBridge = window.lycanDesktop;
let loaded = false;
const screenPreferences = reactive({ hideCursor: false, hideBorder: false });
const screenSupport = ref<{ hideCursor: boolean; hideBorder: boolean }>();
const screenError = ref('');
let screenLoaded = false;

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
  const previous = screenPreferences[key];
  screenPreferences[key] = (event.target as HTMLInputElement).checked;
  try {
    saveScreenSharePreferences(screenPreferences);
    screenError.value = '';
  } catch {
    screenPreferences[key] = previous;
    screenError.value = '无法保存屏幕共享设置。';
  }
}

watch(() => [props.active, props.desktop] as const, ([active, desktop]) => {
  if (!active || !desktop || loaded || !desktopBridge?.getAutoStart) return;
  loaded = true;
  void desktopBridge.getAutoStart().then((settings) => {
    autoStartSupported.value = settings.supported;
    autoStartEnabled.value = settings.enabled;
  }).catch(() => { autoStartError.value = '无法读取开机自启设置'; });
}, { immediate: true });

async function updateAutoStart(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  const previous = autoStartEnabled.value;
  autoStartEnabled.value = enabled;
  autoStartBusy.value = true;
  autoStartError.value = '';
  try {
    const settings = await desktopBridge?.setAutoStart(enabled);
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
    <section class="settings-block">
      <h2>共享观看</h2>
      <label class="settings-toggle">
        <span><strong>自动填充舞台</strong><small>按开始共享的顺序填入最多四路；停止共享或移出后自动补位。手动移出的画面不会自动返回。</small></span>
        <input type="checkbox" :checked="stageAutoFill" aria-label="自动填充舞台"
          @change="emit('stageAutoFill', ($event.target as HTMLInputElement).checked)" />
      </label>
      <p v-if="stagePreferenceError" role="alert" class="settings-error">{{ stagePreferenceError }}</p>
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
          <span><strong>隐藏黄色共享边框</strong><small>{{ screenSupport?.hideBorder
            ? '需要 Windows 授权及安装包权限支持；未获准时会提示，其他应用也可能要求保留边框。'
            : '需要 Windows build 20348 或以上；当前系统无法通过官方接口隐藏边框。' }}</small></span>
          <input type="checkbox" :checked="screenPreferences.hideBorder" :disabled="!screenSupport?.hideBorder"
            aria-label="隐藏黄色共享边框" @change="updateScreenPreference('hideBorder', $event)" />
        </label>
        <p v-if="!screenSupport && !screenError">正在确认系统支持情况…</p>
        <p v-if="screenError" role="alert" class="settings-error">{{ screenError }}</p>
      </template>
    </section>
    <section class="settings-block">
      <h2>系统</h2>
      <p v-if="!desktop">开机自启仅在 Windows 桌面版提供。</p>
      <label v-else class="settings-toggle" :class="{ 'is-disabled': !autoStartSupported || autoStartBusy }">
        <span><strong>开机自动启动</strong><small>{{ autoStartSupported
          ? '使用 Windows 登录项启动，不增加额外常驻进程。'
          : '仅 Windows 安装版支持，开发模式不会修改系统启动项。' }}</small></span>
        <input type="checkbox" :checked="autoStartEnabled" :disabled="!autoStartSupported || autoStartBusy"
          aria-label="开机自动启动" @change="updateAutoStart" />
      </label>
      <p v-if="autoStartError" role="alert" class="settings-error">{{ autoStartError }}</p>
    </section>
  </div>
</template>

<style scoped>
.client-settings { max-width: 760px; }
</style>
