<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { authRequest } from '../../auth/authApi';
import InlineFeedback from '../InlineFeedback.vue';
import AccountLifecycleSettings from './AccountLifecycleSettings.vue';
import MemberAccessSettings from './MemberAccessSettings.vue';

const props = defineProps<{ active: boolean; leaving: boolean }>();
interface ServerSettingsStatus {
  serverName: string;
  publicUrlConfigured: boolean;
  qqEnabled: boolean;
  mediaConfigured: boolean;
}
const status = ref<ServerSettingsStatus | null>(null);
const error = ref('');
const loading = ref(false);
let request: AbortController | undefined;

async function refresh() {
  request?.abort();
  const current = new AbortController();
  request = current;
  loading.value = true;
  error.value = '';
  try {
    const result = await authRequest<ServerSettingsStatus>('server-settings', 'GET', undefined, current.signal);
    if (!current.signal.aborted) status.value = result;
  } catch (reason) {
    if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : '无法读取服务器配置状态';
  } finally {
    if (!current.signal.aborted) loading.value = false;
  }
}

watch(() => props.active, (active) => {
  if (active) void refresh();
  else { request?.abort(); loading.value = false; }
}, { immediate: true });
onScopeDispose(() => request?.abort());
</script>

<template>
  <section class="settings-section owner-settings">
    <section class="settings-block">
      <div class="owner-heading"><h2>服务器配置</h2><button type="button" :disabled="loading || leaving" @click="refresh">刷新状态</button></div>
      <dl v-if="status" class="owner-status">
        <dt>服务器名称</dt><dd>{{ status.serverName }}</dd>
        <dt>邀请入口地址</dt><dd>{{ status.publicUrlConfigured ? '已配置' : '未配置' }}</dd>
        <dt>QQ 登录</dt><dd>{{ status.qqEnabled ? '已开启' : '未开启' }}</dd>
        <dt>媒体服务</dt><dd>{{ status.mediaConfigured ? '已配置' : '未配置' }}</dd>
      </dl>
      <p>这里显示服务器的配置情况，不代表 QQ 登录或语音连接已测试成功。修改部署配置后需重启服务器；此处不显示密钥。</p>
      <InlineFeedback :message="error" :pending="loading && !status ? '正在读取配置状态…' : ''" />
    </section>
    <AccountLifecycleSettings :active="active" :leaving="leaving" :administrator="true" section="owner" />
    <MemberAccessSettings :active="active" />
  </section>
</template>

<style scoped>
.owner-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.owner-heading h2 { margin: 0; }
.owner-status { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr); gap: 10px 20px; margin: 12px 0; font-size: 14px; line-height: 20px; }
.owner-status dt { color: var(--muted); }
.owner-status dd { margin: 0; overflow-wrap: anywhere; }
.owner-settings > .settings-block > p { margin: 0; color: var(--muted); font-size: 12px; line-height: 20px; }
</style>
