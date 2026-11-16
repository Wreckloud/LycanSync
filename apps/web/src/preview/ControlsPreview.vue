<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref } from 'vue';
import { ArrowRight, Check, ChevronDown, Headphones, Mic, Monitor, Settings, UserRound, X } from '@lucide/vue';
import IconButton from '../components/IconButton.vue';
import Avatar from '../components/Avatar.vue';
import SegmentedControl from '../components/SegmentedControl.vue';
import RangeValue from '../components/RangeValue.vue';
import PasswordField from '../components/PasswordField.vue';
import ExpandSection from '../components/ExpandSection.vue';
import InlineFeedback from '../components/InlineFeedback.vue';
import AppNotice from '../components/AppNotice.vue';
import DialogTransition from '../components/DialogTransition.vue';
import HorizontalScroll from '../components/HorizontalScroll.vue';
import VoiceLevelMic from '../components/VoiceLevelMic.vue';
import MemberIdentity from '../components/MemberIdentity.vue';
import ActivityStatus from '../components/ActivityStatus.vue';
import VoiceModeSwitch from '../components/VoiceModeSwitch.vue';
import PresenceModeSwitch from '../components/PresenceModeSwitch.vue';
import GroupMenu from '../components/GroupMenu.vue';
import CallControls from '../components/CallControls.vue';
import ScreenShareCustomQuality from '../components/ScreenShareCustomQuality.vue';
import UpdateRestartDialog from '../components/UpdateRestartDialog.vue';
import RecoveryPasswordDialog from '../components/RecoveryPasswordDialog.vue';
import LogoutConfirmDialog from '../components/LogoutConfirmDialog.vue';
import ProjectAttribution from '../components/ProjectAttribution.vue';
import { useLoadingHint } from '../components/useLoadingHint';
import type { CustomScreenShareQuality, ScreenShareQualityId } from '../rtc/screenShareQuality';
import type { VoiceMode } from '../settings/useAudioShortcuts';
import type { PresenceMode } from '../presence/usePresencePreference';
import type { GroupSummary } from '../group/groupApi';

type PreviewTab = 'compare' | 'gallery' | 'coverage';
const tab = ref<PreviewTab>('compare');
const tabs = [{ id: 'compare', label: '哪里要改 · 前后对照' }, { id: 'gallery', label: '全控件 · 点击体验' }, { id: 'coverage', label: '全部组件 · 覆盖范围' }] as const;
const text = ref('和朋友一起玩游戏');
const signature = ref('这是一段较长的签名，用来检查换行、字数与输入区域。');
const password = ref('preview-only');
const confirmation = ref('');
const volume = ref(100);
const checked = ref(true);
const mode = ref<VoiceMode>('voice');
const presence = ref<PresenceMode>('online');
const segment = ref('standard');
const expanded = ref(false);
const inputDisabled = ref(false);
const forceFocus = ref(false);
const fileName = ref('未选择文件');
const radio = ref('friends');
const activityHovered = ref(false);
const customQuality = ref<CustomScreenShareQuality>({ resolution: 1080, fps: 60 });
const quality = ref<ScreenShareQualityId>('standard');
const microphone = ref(true);
const listening = ref(true);
const outputVolume = ref(1);
const processingEnabled = ref(false);
const sharing = ref(false);
const shareAudio = ref(true);
const voiceBalance = ref(true);
const dialog = ref<'update' | 'password' | 'logout' | null>(null);
const dialogError = ref('');
const notice = ref<{ message: string; kind?: 'success' } | null>(null);
const interaction = ref('点击控件可以检查交互；所有数据仅保留在此页面。');
const group: GroupSummary = { id: 'preview-group', name: '朋友的游戏群', description: '', avatar: '', role: 'OWNER', memberCount: 6,
  createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z' };
const options = [{ id: 'economy', label: '节省流量' }, { id: 'standard', label: '标准' }, { id: 'high', label: '高帧率' }] as const;
const pending = ref(false);
const outcome = ref('尚未开始');
const currentHint = useLoadingHint(() => pending.value, 400);
let finishTimer: ReturnType<typeof setTimeout> | undefined;
function simulateRequest(duration: number, failure = false) {
  clearTimeout(finishTimer);
  pending.value = true;
  outcome.value = '模拟请求进行中';
  finishTimer = setTimeout(() => {
    pending.value = false;
    outcome.value = failure ? '模拟失败：无法保存设置，请重试。' : `模拟结束：${duration} ms`;
  }, duration);
}
function showNotice(success: boolean) {
  notice.value = { message: success ? '预览：片段已保存。' : '预览：连接暂时中断，请重试。', kind: success ? 'success' : undefined };
}
function openDialog(kind: NonNullable<typeof dialog.value>) { dialogError.value = ''; dialog.value = kind; }
function inspectDialog() { dialogError.value = '这是预览反馈，没有更新、退出账号或保存密码。'; }
function chooseFile(event: Event) { fileName.value = (event.target as HTMLInputElement).files?.[0]?.name ?? '未选择文件'; }
onScopeDispose(() => clearTimeout(finishTimer));

// 只列出组件路径，不执行业务组件的 loader；避免挂载账号、请求、采集与真实设备。
const componentPaths = import.meta.glob(['../components/**/*.vue', '../App.vue', '../AuthRoot.vue', '../overlay/*.vue']);
const directNames = new Set(['Avatar', 'IconButton', 'SegmentedControl', 'RangeValue', 'PasswordField', 'ExpandSection', 'InlineFeedback',
  'AppNotice', 'DialogTransition', 'HorizontalScroll', 'VoiceLevelMic', 'MemberIdentity', 'ActivityStatus', 'VoiceModeSwitch',
  'PresenceModeSwitch', 'GroupMenu', 'CallControls', 'ScreenShareCustomQuality', 'UpdateRestartDialog', 'RecoveryPasswordDialog',
  'LogoutConfirmDialog', 'ProjectAttribution']);
const compositeNames = new Set(['GroupChat', 'GroupMembersPanel', 'ParticipantCard', 'PersonalStatusCard', 'ProfilePopover', 'ChatFileCard',
  'ChatImage', 'ScreenSharePicker', 'StartupUpdate', 'SettingsView', 'AudioSettings', 'ProfileSettings', 'ScreenShareSettings']);
const query = ref('');
const catalog = Object.keys(componentPaths).map(path => {
  const name = path.split('/').at(-1)!.replace('.vue', '');
  const direct = directNames.has(name);
  const composite = compositeNames.has(name);
  return { name, path: path.replace('../', 'src/'),
    status: direct ? '真实组件可操作' : composite ? '基础外观示例' : '需业务上下文',
    target: direct ? 'gallery' as const : composite ? 'gallery' as const : null,
    reason: direct ? '直接复用正式组件，事件只更新预览数据。'
      : composite ? '展示所属的控件与布局语言；未挂载完整业务流程。'
        : name.includes('Recording') ? '需要本机录像、文件或桌面桥接。'
          : /Screen|Media|Remote|VoiceOverlay|CallViewing/.test(name) ? '需要媒体轨道、窗口或授权上下文。'
            : '需要账号、群组、设置状态或服务请求；本页不创建真实会话。' };
}).sort((a, b) => a.path.localeCompare(b.path));
const filteredCatalog = computed(() => catalog.filter(item => `${item.name} ${item.path} ${item.status}`.toLowerCase().includes(query.value.toLowerCase())));
const sourceExpanded = ref(false);
async function showComponent(name: string) {
  tab.value = 'gallery';
  await nextTick();
  const sample = [...document.querySelectorAll<HTMLElement>('[data-preview-components]')]
    .find(element => element.dataset.previewComponents?.split(' ').includes(name));
  sample?.scrollIntoView({ block: 'start', behavior: 'instant' });
}
</script>

<template>
  <main class="preview-page">
    <header class="preview-header">
      <div class="preview-wordmark"><span class="preview-mark"><Check :size="19" /></span> LycanSync <span>界面收尾检查</span></div>
      <div class="preview-intro"><div><p class="preview-eyebrow">保留现在的风格，把差异看清楚</p><h1>控件预览与调整对照</h1>
        <p>先看哪里真的有问题，再决定要不要改。封装只是整理代码时，外观可以保持完全一致。</p></div><span class="preview-local">本地预览 · 不连接账号或设备</span></div>
      <nav class="preview-tabs" aria-label="检查页面">
        <button v-for="item in tabs" :key="item.id" type="button" :aria-current="tab === item.id ? 'page' : undefined" @click="tab = item.id">{{ item.label }}</button>
      </nav>
    </header>

    <section v-if="tab === 'compare'" class="preview-content" aria-label="调整前后对照">
      <div class="preview-section-heading"><h2>不是每一处都需要改外观</h2><p>圆角、键盘焦点和等待提示已应用；头像及弹窗已整理。调整前快照只留在此检查页，开关标题保持原操作。</p></div>
      <article class="preview-comparison" id="compare-buttons">
        <header><span class="preview-label">一致性差异</span><h3>普通按钮和选择框的圆角</h3><p>调整前基础按钮为 5px，选择框为 6px；现在统一使用公共的 6px 变量。这是细节收敛，不改变尺寸。</p></header>
        <div class="preview-pair"><div><h4>调整前 · 样式快照</h4><div class="preview-stage preview-actions preview-before-radius"><button type="button">更换头像</button><select aria-label="当前画质"><option>标准画质</option></select></div><p>仅在本页保留 5px 旧样式用于对照。</p></div>
          <div><h4>已应用 · 普通控件统一为 6px</h4><div class="preview-stage preview-actions"><button type="button">更换头像</button><select aria-label="建议画质"><option>标准画质</option></select></div><p>只调整普通控件；头像、开关和拼接按钮不套这个规则。</p></div></div>
        <footer>收益：同类控件更一致。影响很小，如果你看不出差别，也可以不改。</footer>
      </article>

      <article class="preview-comparison" id="compare-focus">
        <header><span class="preview-label">可用性候选</span><h3>键盘操作时，能否看见当前按钮</h3><p>原先移除了默认外圈，普通按钮缺少统一反馈。现在用边框和底色提示键盘焦点，不增加外圈。</p></header>
        <label class="preview-option"><input v-model="forceFocus" type="checkbox" /> 并排显示焦点示意，也可以用 Tab 实际移动焦点</label>
        <div class="preview-pair"><div><h4>调整前 · 焦点快照</h4><div class="preview-stage preview-before-focus"><button type="button">试听</button></div><p>不额外补充焦点外观。</p></div>
          <div><h4>已应用 · 边框和底色提示</h4><div class="preview-stage preview-focus-proposal" :class="{ 'preview-force-focus': forceFocus }"><button type="button">试听</button></div><p>不增加外圈，不改变按钮大小，只有键盘焦点时强调。</p></div></div>
        <footer>收益：键盘使用更清楚；鼠标操作时基本保持原样。</footer>
      </article>

      <article class="preview-comparison" id="compare-feedback">
        <header><span class="preview-label">已确认的时机差异</span><h3>短请求是否闪一下“正在读取”</h3><p>原先部分加载提示等待 400ms，其他等待 1 秒。现在统一默认等待 1 秒；下面保留旧时机方便比较。</p></header>
        <div class="preview-actions"><button type="button" :disabled="pending" @click="simulateRequest(600)">试 600ms 请求</button><button type="button" :disabled="pending" @click="simulateRequest(1600)">试 1.6 秒请求</button><button type="button" :disabled="pending" @click="simulateRequest(1200, true)">试失败反馈</button></div>
        <div class="preview-pair"><div><h4>调整前 · 400ms 后显示</h4><div class="preview-stage preview-feedback-stage"><span v-if="currentHint" role="status">正在读取…</span><InlineFeedback v-if="!pending && outcome.startsWith('模拟失败')" :message="outcome" /></div></div>
          <div><h4>已应用 · 1 秒后显示</h4><div class="preview-stage preview-feedback-stage"><InlineFeedback :pending="pending ? '正在读取…' : ''" :message="!pending && outcome.startsWith('模拟失败') ? outcome : ''" /></div></div></div>
        <footer aria-live="polite">{{ outcome }}。预览框保留高度仅用于对照；正式界面无提示时不占位。</footer>
      </article>

      <article class="preview-comparison" id="compare-toggle">
        <header><span class="preview-label preview-label-neutral">已确认保留</span><h3>开关标题不触发切换，避免误触</h3><p>维持原来的精确点击范围：只有右侧开关可切换，标题和说明不响应点击。开关获得焦点后仍可用空格操作。</p></header>
        <div class="preview-stage"><div class="settings-toggle"><span><strong>显示当前动态</strong><small>点击这段标题或说明不会切换。</small></span><input v-model="checked" type="checkbox" aria-label="当前显示动态" /></div></div>
        <footer>整行点击提案已移除，不会应用到正式界面。</footer>
      </article>

      <article class="preview-comparison" id="compare-avatar">
        <header><span class="preview-label preview-label-neutral">内部整理 · 外观不变</span><h3>头像封装并不等于重新设计头像</h3><p>多处代码分别处理图片和缺省占位。提取纯展示组件，是为了以后改一个地方就能保持一致；目前不能据此断言头像显示有问题。</p></header>
        <div class="preview-pair"><div><h4>当前展示</h4><div class="preview-stage"><MemberIdentity :member="{ nickname: '朋友的昵称', avatar: '' }" description="正在游戏" /></div></div>
          <div><h4>封装目标 · 同样的外观</h4><div class="preview-stage"><MemberIdentity :member="{ nickname: '朋友的昵称', avatar: '' }" description="正在游戏" /></div></div></div>
        <footer>两边特意使用同一个真实组件来表达“不改外观”。Avatar 已接入四处展示；资料请求、在线状态、删除账号占位规则仍由业务决定。</footer>
      </article>

      <article class="preview-comparison" id="compare-dialog">
        <header><span class="preview-label preview-label-neutral">内部整理 · 保留现状</span><h3>弹窗统一的是外壳责任，不是所有弹窗都长一样</h3><p>普通确认弹窗重复维护边框、标题、滚动和操作区。已有 DialogTransition 负责背景隔离与过渡，这部分继续复用。</p></header>
        <div class="preview-actions"><button type="button" @click="openDialog('update')">打开真实更新确认框</button><button type="button" @click="openDialog('password')">打开真实密码表单</button><button type="button" @click="openDialog('logout')">打开真实退出确认框</button></div>
        <footer>这些都直接使用当前组件。已收敛四处普通外壳样式，没有增加壳组件；裁剪、观看和多步选择器不强行合并。</footer>
      </article>
    </section>

    <section v-if="tab === 'gallery'" class="preview-content" aria-label="全控件预览">
      <div class="preview-section-heading"><h2>直接操作现有控件</h2><p>真实组件直接复用；业务布局示例会单独注明。可以点击、拖动、输入和用键盘操作。</p></div>
      <p class="preview-interaction" role="status">{{ interaction }}</p>
      <div class="preview-gallery">
        <article class="preview-sample" data-preview-components="IconButton"><header><h3>按钮与图标按钮</h3><span>正式 CSS / IconButton</span></header><div class="preview-actions"><button type="button" @click="interaction = '普通按钮已点击。'">普通操作</button><button type="button" class="confirm-button" @click="interaction = '主要操作已点击。'">确认</button><button type="button" disabled>不可用</button><IconButton label="预览设置" @click="interaction = '设置图标已点击。'"><Settings :size="17" /></IconButton><IconButton label="预览关闭" @click="interaction = '关闭图标已点击。'"><X :size="17" /></IconButton></div><div class="card-actions"><button type="button">取消</button><button type="button" class="confirm-button is-danger card-actions-end">危险操作示意</button></div><p>尝试悬停、Tab、Enter。危险操作只改变预览，不执行删除。</p></article>
        <article class="preview-sample" data-preview-components="PasswordField"><header><h3>文字、密码与多行输入</h3><span>原生控件 / PasswordField</span></header><label class="preview-option"><input v-model="inputDisabled" type="checkbox" /> 禁用本组输入</label><label class="settings-field">昵称<input v-model="text" :disabled="inputDisabled" maxlength="40" /></label><PasswordField id="preview-password" v-model="password" label="示例密码" :disabled="inputDisabled" /><label class="settings-field">签名<textarea v-model="signature" :disabled="inputDisabled" rows="2" /></label><label class="settings-field">只读状态<input value="此字段只读" readonly /></label><label class="settings-field">错误状态示意<input value="过长的昵称示意" aria-invalid="true" /><InlineFeedback message="请检查昵称长度。" /></label></article>
        <article class="preview-sample" data-preview-components="SettingsView"><header><h3>选择框、开关与单选</h3><span>原生控件 / 设置公共样式</span></header><label class="settings-field">输入设备<select :disabled="inputDisabled"><option>系统默认设备</option><option>示例麦克风 A</option><option disabled>示例设备不可用</option></select></label><div class="settings-toggle"><span><strong>显示当前动态</strong><small>只有右侧开关切换，避免误触。</small></span><input v-model="checked" type="checkbox" /></div><div class="settings-toggle"><span><strong>不可用的开关</strong><small>保留限制说明，不伪装成已开启。</small></span><input type="checkbox" disabled aria-label="不可用开关" /></div><div class="preview-actions"><label><input v-model="radio" type="radio" value="friends" /> 好友可见</label><label><input v-model="radio" type="radio" value="private" /> 仅自己</label></div></article>
        <article class="preview-sample" data-preview-components="SegmentedControl VoiceModeSwitch PresenceModeSwitch"><header><h3>分段切换与业务模式</h3><span>真实组件</span></header><SegmentedControl v-model="segment" :options="options" label="示例画质模式" /><VoiceModeSwitch v-model="mode" binding="Ctrl + M" /><PresenceModeSwitch :mode="presence" ready active @select="presence = $event" /><SegmentedControl model-value="standard" :options="options" label="禁用的分段切换" disabled /><p>支持左右方向键；模式切换只更新此页面。</p></article>
        <article class="preview-sample" data-preview-components="RangeValue VoiceLevelMic AudioSettings"><header><h3>滑块、数值撤回与输入等级</h3><span>原生 range / RangeValue / VoiceLevelMic</span></header><label class="preview-range">输入音量<RangeValue :value="volume" label="恢复预览音量" @reset="volume = $event">{{ volume }}%</RangeValue><input v-model.number="volume" type="range" min="0" max="200" step="5" /></label><div class="preview-actions"><VoiceLevelMic :level="volume / 200" :size="28" /><span>等级示例随滑块变化，不采集声音。</span></div><div class="settings-meter"><div role="meter" aria-label="示例输入等级" :aria-valuenow="Math.min(volume, 100)" aria-valuemin="0" aria-valuemax="100"><i v-for="n in 16" :key="n" :class="{ 'is-active': n * 100 / 16 <= volume }" /></div></div></article>
        <article class="preview-sample" data-preview-components="ScreenShareCustomQuality ScreenShareSettings"><header><h3>自定义画质与数值校验</h3><span>ScreenShareCustomQuality</span></header><ScreenShareCustomQuality v-model="customQuality" /><p>展开码率设置后可输入非法值，检查错误与重试；不会改变真实共享偏好。</p></article>
        <article class="preview-sample" data-preview-components="InlineFeedback AppNotice"><header><h3>局部反馈与全局通知</h3><span>InlineFeedback / AppNotice</span></header><InlineFeedback message="示例失败：无法保存，请重试。" /><InlineFeedback status="这是持续状态说明。" /><div class="preview-actions"><button type="button" @click="showNotice(true)">显示成功通知</button><button type="button" @click="showNotice(false)">显示异常通知</button></div><p>顶部通知直接复用正式组件，4 秒后自动关闭。</p></article>
        <article class="preview-sample" data-preview-components="ExpandSection"><header><h3>展开区域与短过渡</h3><span>ExpandSection</span></header><button type="button" class="settings-button" :aria-expanded="expanded" aria-controls="preview-expanded" @click="expanded = !expanded">{{ expanded ? '收起详细选项' : '展开详细选项' }}<ChevronDown :size="15" /></button><ExpandSection :open="expanded" id="preview-expanded"><div class="preview-expand-content"><label class="settings-field">示例选项<select><option>系统默认</option><option>手动选择</option></select></label><InlineFeedback status="展开只影响本页内容，不加载设备。" /></div></ExpandSection><p>连续点击，观察反向衔接。也可在系统开启减少动态效果后重试。</p></article>
        <article class="preview-sample" data-preview-components="Avatar MemberIdentity ActivityStatus PersonalStatusCard ProfilePopover ProfileSettings"><header><h3>身份、头像与活动长文本</h3><span>MemberIdentity / ActivityStatus；群头像为布局示例</span></header><MemberIdentity :member="{ nickname: '朋友的昵称', avatar: '' }" description="正在游戏" /><div class="preview-actions"><span class="preview-group-avatar"><Avatar :icon-size="24" /></span><span>群头像保留圆角方形。</span></div><div class="preview-activity" @mouseenter="activityHovered = true" @mouseleave="activityHovered = false"><ActivityStatus type="GAME" text="正在玩 一款名字很长很长的游戏，用来检查溢出内容是否在悬停时滚动" :active="activityHovered" /></div><p>鼠标移入长文本，检查溢出往返与移出复位。</p></article>
        <article class="preview-sample" data-preview-components="GroupMenu DialogTransition UpdateRestartDialog RecoveryPasswordDialog LogoutConfirmDialog"><header><h3>群菜单与弹窗</h3><span>真实组件，事件不连接业务</span></header><div class="preview-group-heading"><GroupMenu :group="group" @select="interaction = `选择了群菜单 ${$event}，未执行真实操作。`" /></div><div class="preview-actions"><button type="button" @click="openDialog('update')">更新确认</button><button type="button" @click="openDialog('password')">密码表单</button><button type="button" @click="openDialog('logout')">退出确认</button></div><p>检查外部点击、Esc、Tab 循环及关闭后的焦点。</p></article>
        <article class="preview-sample preview-sample-wide" data-preview-components="CallControls"><header><h3>通话分体按钮与快捷菜单</h3><span>CallControls；展示值为本地模拟</span></header><div class="preview-call-stage callbar"><CallControls connected :desktop="false" :microphone-enabled="microphone" :microphone-intent="microphone" :microphone-busy="false" :microphone-level="volume / 200" :input-level-percent="Math.min(volume, 100)" :listening="listening" :input-gain="volume / 100" :output-volume="outputVolume" :sharing="sharing" :share-busy="false" :choosing-source="false" :share-limit-reached="false" :quality="quality" :share-audio="shareAudio" audio-mode="systemMix" :voice-mode="mode" shortcuts-ready shortcuts-supported :voice-volume-balance="voiceBalance" @microphone="microphone = !microphone" @listening="listening = !listening" @share="sharing = !sharing" @share-audio="shareAudio = $event" @quality="quality = $event" @input-gain="volume = Math.round($event * 100)" @output-volume="outputVolume = $event" :processing-enabled="processingEnabled" @processing="processingEnabled = $event" @voice-mode="mode = $event" @voice-volume-balance="voiceBalance = $event" @settings="interaction = '这里只预览快捷菜单；完整音频设置需业务上下文。'" /></div><p>主图标切换模拟状态，箭头展开真实菜单。没有真实房间、麦克风或屏幕采集。</p></article>
        <article class="preview-sample preview-sample-wide" data-preview-components="HorizontalScroll GroupMembersPanel ParticipantCard ScreenSharePicker"><header><h3>横向成员条与媒体卡片</h3><span>HorizontalScroll 真实；内容为静态布局示例</span></header><HorizontalScroll label="预览成员横向滚动"><div class="preview-member-strip"><button v-for="n in 8" :key="n" type="button" class="preview-member" @click="interaction = `点击了成员 ${n}，未打开共享。`"><span><UserRound :size="30" /></span><strong>朋友 {{ n }}</strong><small><Mic :size="12" /> 已连接</small></button></div></HorizontalScroll><p>滚轮、拖动或方向键横向查看；这里只检查布局和滚动，不代表实际视频性能。</p></article>
        <article class="preview-sample" data-preview-components="GroupChat ChatFileCard ChatImage"><header><h3>聊天内容、附件与传输</h3><span>静态布局示例 / 正式聊天 CSS</span></header><div class="preview-chat"><article class="chat-message"><span class="chat-message-avatar chat-message-initial">友</span><div class="chat-message-body"><div class="chat-message-meta"><strong>朋友</strong><time>20:30</time></div><p class="chat-message-content">今晚一起玩？ <a href="#" @click.prevent="interaction = '示例链接没有访问外部网站。'">一段链接</a></p></div></article><label class="settings-field">消息草稿<textarea rows="2" placeholder="输入一段文字检查换行…" /></label><label class="preview-file-picker">选择预览文件<input type="file" @change="chooseFile" /></label><span class="preview-small">{{ fileName }}（仅显示文件名，不读取或上传）</span><progress :value="volume" max="200" aria-label="模拟传输进度" /></div><p>这是组合示例，未挂载 GroupChat 或执行上传。</p></article>
        <article class="preview-sample" data-preview-components="ProjectAttribution StartupUpdate"><header><h3>字体、颜色与状态</h3><span>正式 tokens / 布局示例</span></header><div class="preview-swatches"><span v-for="color in ['--background', '--panel', '--panel-sidebar', '--panel-raised', '--accent', '--good', '--danger']" :key="color"><i :style="{ background: `var(${color})` }" />{{ color }}</span></div><div class="preview-actions"><span class="preview-status-good"><Check :size="15" />已连接</span><span class="preview-status-muted"><Headphones :size="15" />未加入</span><span class="preview-status-danger"><X :size="15" />失败</span></div><ProjectAttribution>组件样式与能力归属说明同样复用已有的 ProjectAttribution。</ProjectAttribution></article>
      </div>
    </section>

    <section v-if="tab === 'coverage'" class="preview-content" aria-label="组件覆盖清单">
      <div class="preview-section-heading"><h2>{{ catalog.length }} 个组件与入口，逐项列出</h2><p>“真实组件”可以在本页体验；“基础外观示例”仅覆盖视觉语言；“需业务上下文”仍要回到完整流程验收。</p></div>
      <div class="preview-coverage-summary"><span>{{ directNames.size }} 个真实组件</span><span>{{ compositeNames.size }} 个基础外观示例</span><span>{{ catalog.length - directNames.size - compositeNames.size }} 个需要业务上下文</span></div>
      <label class="settings-field preview-search">查找组件<input v-model="query" placeholder="组件名、路径或覆盖状态" /></label>
      <div class="preview-table-wrap"><table><thead><tr><th>组件</th><th>当前覆盖</th><th>边界与待验收内容</th></tr></thead><tbody><tr v-for="item in filteredCatalog" :key="item.path"><td><strong>{{ item.name }}</strong><small>{{ item.path }}</small></td><td><button v-if="item.target" type="button" class="preview-text-action" @click="showComponent(item.name)">{{ item.status }} <ArrowRight :size="13" /></button><span v-else>{{ item.status }}</span></td><td>{{ item.reason }}</td></tr></tbody></table></div>
      <button type="button" class="settings-button" :aria-expanded="sourceExpanded" @click="sourceExpanded = !sourceExpanded">查看本页的验证边界</button><ExpandSection :open="sourceExpanded"><p class="preview-boundary">本页不导入 AuthRoot，不执行清单中的业务组件 loader，不访问 API、不读取账号、不采集或发布媒体。建议样式以 preview 前缀限制在本页。此页面不加入正式构建入口。它覆盖控件检查，不代替完整账号、通话、权限、媒体与性能验收。</p></ExpandSection>
    </section>
    <footer class="preview-footer"><Monitor :size="15" /> 已确认的圆角、键盘焦点、等待时机与内部整理已应用。开关标题保留原行为，其余新想法仍需单独确认。</footer>
  </main>
  <AppNotice v-if="notice" :key="notice.message" :message="notice.message" :kind="notice.kind" @dismiss="notice = null" />
  <DialogTransition><UpdateRestartDialog v-if="dialog === 'update'" version="0.5.5" :busy="false" :error="dialogError" @cancel="dialog = null" @confirm="inspectDialog" /></DialogTransition>
  <DialogTransition><RecoveryPasswordDialog v-if="dialog === 'password'" v-model:password="password" v-model:confirmation="confirmation" :configured="false" :busy="false" :error="dialogError" @cancel="dialog = null" @save="inspectDialog" /></DialogTransition>
  <DialogTransition><LogoutConfirmDialog v-if="dialog === 'logout'" :administrator="false" :busy="false" :error="dialogError" @cancel="dialog = null" @confirm="inspectDialog" /></DialogTransition>
</template>
