<script setup lang="ts">
import { computed, onMounted, onScopeDispose, reactive, ref, watch } from 'vue';
import { AudioLines, ChevronDown, ChevronLeft, ChevronRight, Copy, CornerUpLeft, HeadphoneOff, Headphones,
  LogOut, MessageSquareText, Mic, MicOff, Minus, MonitorUp, Plus, RadioTower,
  Send, SlidersHorizontal, Square, UserRound, UsersRound, X } from '@lucide/vue';
import { RemoteAudioTrack, Track, type Participant } from 'livekit-client';
import ParticipantCard from './components/ParticipantCard.vue';
import RemoteAudio from './components/RemoteAudio.vue';
import IconButton from './components/IconButton.vue';
import AvatarCropDialog from './components/AvatarCropDialog.vue';
import { createGroup, findGroup, findGroups, type GroupDetail, type GroupSummary } from './group/groupApi';
import { useRtcRoom } from './rtc/useRtcRoom';
import { useRoomSummary } from './rtc/useRoomSummary';
import type { AuthUser } from './auth/authApi';

const props = defineProps<{ user: AuthUser; windowMaximized: boolean }>();
const emit = defineEmits<{ profile: [] }>();

const STATUS_LABELS = { idle: '未加入语音', joining: '正在连接', connected: '语音已连接', reconnecting: '正在重连' };
const CALLBAR_EXIT_DURATION_MS = 180;
const GROUP_REFRESH_INTERVAL_MS = 15_000;
const rtc = reactive(useRtcRoom());
const desktop = window.lycanDesktop;
const captureRequest = ref<CaptureRequest | null>(null);
function selectCaptureSource(sourceId: string | null) {
  if (!captureRequest.value) return;
  desktop?.selectSource(captureRequest.value.requestId, sourceId);
  captureRequest.value = null;
}
const removeCaptureListener = desktop?.onSources((request) => { captureRequest.value = request; });
const removeCloseListener = desktop?.onClose(async () => {
  selectCaptureSource(null);
  try { await rtc.leave(); }
  finally { desktop.finishClose(); }
});
onScopeDispose(() => { selectCaptureSource(null); removeCaptureListener?.(); removeCloseListener?.(); detailRequest?.abort(); listRequest?.abort(); void rtc.leave(); });
watch(() => rtc.status, (status) => { if (status === 'idle') selectCaptureSource(null); });
const groups = ref<GroupSummary[]>([]);
const selectedGroupId = ref<string | null>(null);
const selectedGroupDetail = ref<GroupDetail | null>(null);
const joinedGroupDetail = ref<GroupDetail | null>(null);
const groupError = ref('');
const summaryError = ref<string | null>(null);
const groupLoading = ref(false);
const editorOpen = ref(false);
const formName = ref('');
const formDescription = ref('');
const formAvatar = ref('');
const formAvatarFile = ref<File | null>(null);
const groupAvatarInput = ref<HTMLInputElement | null>(null);
const formError = ref('');
const formBusy = ref(false);
let detailRequest: AbortController | null = null;
let listRequest: AbortController | null = null;
let joinAttempt = 0;

async function loadGroup(groupId: string, keepExisting = false) {
  detailRequest?.abort();
  const request = new AbortController();
  detailRequest = request;
  if (!keepExisting) selectedGroupDetail.value = null;
  groupError.value = '';
  groupLoading.value = !keepExisting;
  try {
    const detail = await findGroup(groupId, request.signal);
    if (!request.signal.aborted && selectedGroupId.value === groupId) {
      selectedGroupDetail.value = detail;
      if (joinedGroupId.value === groupId) joinedGroupDetail.value = detail;
    }
  } catch (error) {
    if (!request.signal.aborted) groupError.value = error instanceof Error ? error.message : '无法读取群组资料';
  } finally {
    if (!request.signal.aborted) groupLoading.value = false;
  }
}

async function refreshGroups(refreshDetail = true) {
  listRequest?.abort();
  const request = new AbortController();
  listRequest = request;
  try {
    const result = await findGroups(request.signal);
    if (request.signal.aborted) return;
    groups.value = result;
    groupError.value = '';
    if (!selectedGroupId.value || !result.some((group) => group.id === selectedGroupId.value)) {
      selectedGroupId.value = result[0]?.id ?? null;
    }
    if (selectedGroupId.value) {
      const selectedSummary = result.find((group) => group.id === selectedGroupId.value);
      const keepExisting = selectedGroupDetail.value?.id === selectedGroupId.value;
      if (refreshDetail || !keepExisting || selectedGroupDetail.value?.memberCount !== selectedSummary?.memberCount) {
        void loadGroup(selectedGroupId.value, keepExisting);
      }
    } else selectedGroupDetail.value = null;
  } catch (error) {
    if (!request.signal.aborted) groupError.value = error instanceof Error ? error.message : '无法读取群组列表';
  }
}
let groupRefreshTimer: ReturnType<typeof setInterval> | null = null;
let lastActivationRefreshAt = 0;
function refreshOnActivation() {
  if (document.visibilityState === 'hidden' || Date.now() - lastActivationRefreshAt < 500) return;
  lastActivationRefreshAt = Date.now();
  void refreshGroups();
}
onMounted(() => {
  refreshOnActivation();
  window.addEventListener('focus', refreshOnActivation);
  document.addEventListener('visibilitychange', refreshOnActivation);
  groupRefreshTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void refreshGroups(false);
  }, GROUP_REFRESH_INTERVAL_MS);
});
onScopeDispose(() => {
  window.removeEventListener('focus', refreshOnActivation);
  document.removeEventListener('visibilitychange', refreshOnActivation);
  if (groupRefreshTimer) clearInterval(groupRefreshTimer);
});

function openEditor() {
  editorOpen.value = true;
  formName.value = '';
  formDescription.value = '';
  formAvatar.value = '';
  formAvatarFile.value = null;
  formError.value = '';
}

function pickGroupAvatar(event: Event) {
  const input = event.target as HTMLInputElement;
  formAvatarFile.value = input.files?.[0] ?? null;
  input.value = '';
  formError.value = '';
}

async function submitEditor() {
  if (formBusy.value || formAvatarFile.value) return;
  formBusy.value = true;
  formError.value = '';
  try {
    const detail = await createGroup(formName.value, formDescription.value, formAvatar.value);
    await refreshGroups();
    groups.value = groups.value.some((group) => group.id === detail.id) ? groups.value : [...groups.value, detail];
    selectedGroupId.value = detail.id;
    selectedGroupDetail.value = detail;
    editorOpen.value = false;
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '操作失败';
  } finally {
    formBusy.value = false;
  }
}
const joinedGroupId = ref<string | null>(null);
const joiningGroupId = ref<string | null>(null);
const pendingSwitchGroupId = ref<string | null>(null);
const listening = ref(true);
const volume = ref(0.72);
const lastVolume = ref(0.72);
const volumeOpen = ref(false);
const enlargedIdentities = ref<string[]>([]);
const stageDismissed = ref(false);
const focusedIdentity = ref<string | null>(null);
const membersExpanded = ref(false);
const filmstripPage = ref(0);
const viewerGrid = ref<HTMLElement | null>(null);
const lockedViewerHeight = ref<number | null>(null);
const viewerNotice = ref('');
const departingGroupId = ref<string | null>(null);
const callbarLeaving = ref(false);
let listeningSync: Promise<void> | null = null;
let viewerUnlockTimer: ReturnType<typeof setTimeout> | null = null;
function releaseViewerLock() {
  if (viewerUnlockTimer) clearTimeout(viewerUnlockTimer);
  viewerUnlockTimer = null;
  lockedViewerHeight.value = null;
}
onScopeDispose(releaseViewerLock);

const selectedGroup = computed(() => groups.value.find((group) => group.id === selectedGroupId.value) ?? null);
const joinedGroup = computed(() => groups.value.find((group) => group.id === joinedGroupId.value) ?? null);
const callbarGroup = computed(() => joinedGroup.value ?? groups.value.find((group) => group.id === departingGroupId.value) ?? null);
const pendingSwitchGroup = computed(() => groups.value.find((group) => group.id === pendingSwitchGroupId.value) ?? null);
const localParticipant = computed(() => rtc.room?.localParticipant);
const connected = computed(() => rtc.status === 'connected');
const showingJoinedGroup = computed(() => joinedGroupId.value !== null && selectedGroupId.value === joinedGroupId.value);
const roomSummary = useRoomSummary(selectedGroupId, computed(() => !showingJoinedGroup.value),
  (message) => { summaryError.value = message; });
const currentMembers = computed(() => joinedGroupDetail.value?.members ?? []);
const participantAvatar = (identity: string) => identity === `user-${props.user.id}` ? props.user.avatar
  : currentMembers.value.find((member) => `user-${member.userId}` === identity)?.avatar ?? '';
const previewParticipantName = (identity: string, displayName: string) =>
  selectedGroupDetail.value?.members.find((member) => `user-${member.userId}` === identity)?.nickname ?? displayName;
const previewParticipantAvatar = (identity: string) =>
  selectedGroupDetail.value?.members.find((member) => `user-${member.userId}` === identity)?.avatar ?? '';
const groupParticipants = computed(() => showingJoinedGroup.value ? rtc.participants : []);
const sharingParticipants = computed(() => groupParticipants.value.filter((participant) => participant.isScreenShareEnabled));
const filmstripPageCount = computed(() => Math.ceil(groupParticipants.value.length / 5));
const filmstripParticipants = computed(() => groupParticipants.value.slice(filmstripPage.value * 5, (filmstripPage.value + 1) * 5));
const activeScreenShareCount = computed(() => rtc.participants.filter((participant) => participant.isScreenShareEnabled).length);
// TODO: 服务端按群组原子分配并回收共享名额，处理并发开启、断线及失败；前端限制仅作提示。
const screenShareLimitReached = computed(() => activeScreenShareCount.value >= 8 && !localParticipant.value?.isScreenShareEnabled);
const sharingIdentityKey = computed(() => sharingParticipants.value.map((participant) => participant.identity).join('|'));
const enlargedParticipants = computed(() => enlargedIdentities.value
  .map((identity) => sharingParticipants.value.find((participant) => participant.identity === identity))
  .filter((participant) => participant !== undefined));
const hasStage = computed(() => enlargedParticipants.value.length > 0);
const focusedOnSelectedGroup = computed(() => hasStage.value && showingJoinedGroup.value
  && enlargedParticipants.value.some((participant) => participant.identity === focusedIdentity.value));
const displayedParticipants = computed(() => focusedOnSelectedGroup.value
  ? enlargedParticipants.value.filter((participant) => participant.identity === focusedIdentity.value)
  : enlargedParticipants.value);

watch(sharingIdentityKey, (key) => {
  // 首次共享默认展示一路；手动取消全部放大后，新轨道变化不强迫用户回到舞台。
  const available = key ? key.split('|') : [];
  if (!available.length) stageDismissed.value = false;
  const retained = enlargedIdentities.value.filter((id) => available.includes(id)).slice(0, 4);
  enlargedIdentities.value = retained.length || !available.length || stageDismissed.value ? retained : [available[0]];
  if (focusedIdentity.value && !available.includes(focusedIdentity.value)) focusedIdentity.value = null;
});
watch(() => groupParticipants.value.map((participant) => participant.identity).join('|'), () => {
  filmstripPage.value = Math.min(filmstripPage.value, Math.max(0, filmstripPageCount.value - 1));
});
watch(() => [joinedGroupId.value, joiningGroupId.value, rtc.status, rtc.room], () => {
  if (joinedGroupId.value && rtc.status === 'idle' && rtc.room === null && joiningGroupId.value === null) {
    departingGroupId.value = joinedGroupId.value;
    callbarLeaving.value = true;
    joinedGroupId.value = null;
  }
});
watch(callbarLeaving, (leaving, _, onCleanup) => {
  if (!leaving) return;
  const timer = setTimeout(() => {
    callbarLeaving.value = false;
    departingGroupId.value = null;
  }, CALLBAR_EXIT_DURATION_MS);
  onCleanup(() => clearTimeout(timer));
});
const remoteAudioTracks = computed(() => rtc.participants
  .filter((participant) => participant !== localParticipant.value)
  .map((participant) => participant.getTrackPublication(Track.Source.Microphone)?.track)
  .filter((track): track is RemoteAudioTrack => track instanceof RemoteAudioTrack));
async function joinGroup(groupId: string) {
  releaseViewerLock();
  const attempt = ++joinAttempt;
  selectedGroupId.value = groupId;
  pendingSwitchGroupId.value = null;
  joiningGroupId.value = groupId;
  enlargedIdentities.value = [];
  stageDismissed.value = false;
  focusedIdentity.value = null;
  membersExpanded.value = false;
  viewerNotice.value = '';
  volumeOpen.value = false;
  callbarLeaving.value = false;
  departingGroupId.value = null;

  if (joinedGroupId.value !== null) {
    await rtc.leave();
    joinedGroupId.value = null;
  }

  if (attempt !== joinAttempt) return;
  try {
    joinedGroupDetail.value = selectedGroupDetail.value?.id === groupId
      ? selectedGroupDetail.value : await findGroup(groupId);
  } catch (error) {
    viewerNotice.value = error instanceof Error ? error.message : '无法读取群组成员';
    joiningGroupId.value = null;
    return;
  }
  if (attempt !== joinAttempt) return;

  const joined = await rtc.join(groupId);
  if (attempt !== joinAttempt) return;
  if (joined) {
    joinedGroupId.value = groupId;
    listening.value = true;
    volume.value = lastVolume.value || 0.72;
    void refreshGroups();
  }
  joiningGroupId.value = null;
}

function requestJoin(groupId: string) {
  if (joiningGroupId.value !== null) return;
  selectedGroupId.value = groupId;
  viewerNotice.value = '';

  if (joinedGroupId.value === groupId) {
    pendingSwitchGroupId.value = null;
    return;
  }
  enlargedIdentities.value = [];
  stageDismissed.value = false;
  focusedIdentity.value = null;
  membersExpanded.value = false;
  if (joinedGroupId.value !== null) {
    pendingSwitchGroupId.value = groupId;
    return;
  }
  void joinGroup(groupId);
}

function leaveVoice() {
  releaseViewerLock();
  joinAttempt++;
  const leavingGroupId = joinedGroupId.value ?? joiningGroupId.value;
  if (leavingGroupId !== null) {
    // RTC 立即离房，仅保留短暂的界面快照来完成底栏退场动画。
    departingGroupId.value = leavingGroupId;
    callbarLeaving.value = true;
  }
  rtc.leave();
  joinedGroupId.value = null;
  joinedGroupDetail.value = null;
  joiningGroupId.value = null;
  pendingSwitchGroupId.value = null;
  enlargedIdentities.value = [];
  stageDismissed.value = false;
  focusedIdentity.value = null;
  membersExpanded.value = false;
  viewerNotice.value = '';
  volumeOpen.value = false;
  void refreshGroups();
}

async function toggleMicrophone() {
  if (!connected.value || !localParticipant.value) return;
  const shouldEnableMicrophone = !localParticipant.value.isMicrophoneEnabled;
  if (shouldEnableMicrophone && !listening.value) {
    listening.value = true;
    volume.value = lastVolume.value || 0.72;
    await synchronizeListeningState();
    return;
  }
  await rtc.setMediaEnabled(Track.Source.Microphone, shouldEnableMicrophone);
}

function synchronizeListeningState() {
  if (!connected.value) return Promise.resolve();
  if (listeningSync) return listeningSync;
  // 音量滑块可能连续跨过零点；串行追赶最后状态，避免异步开关完成顺序颠倒。
  listeningSync = (async () => {
    let applied: boolean;
    do {
      applied = listening.value;
      await Promise.all([
        rtc.updateListeningState(applied),
        rtc.setMediaEnabled(Track.Source.Microphone, applied),
      ]);
    } while (connected.value && applied !== listening.value);
  })().finally(() => { listeningSync = null; });
  return listeningSync;
}

async function toggleListening() {
  if (!connected.value) return;
  if (rtc.needsAudioPlayback) {
    await rtc.enableAudioPlayback();
    return;
  }
  if (listening.value) {
    lastVolume.value = volume.value || lastVolume.value;
    listening.value = false;
    volumeOpen.value = false;
  } else {
    listening.value = true;
    volume.value = lastVolume.value || 0.72;
  }
  await synchronizeListeningState();
}

function updateVolume(nextVolume: number) {
  const nextListening = nextVolume > 0;
  volume.value = nextVolume;
  const listeningChanged = nextListening !== listening.value;
  listening.value = nextListening;
  if (nextVolume > 0) lastVolume.value = nextVolume;
  if (listeningChanged) void synchronizeListeningState();
}

function toggleEnlargedParticipant(identity: string) {
  viewerNotice.value = '';
  if (!enlargedIdentities.value.includes(identity) && enlargedIdentities.value.length >= 4) {
    viewerNotice.value = '主观看区最多同时显示四路共享，请先移除一路已放大的画面。';
    return;
  }
  enlargedIdentities.value = enlargedIdentities.value.includes(identity)
    ? enlargedIdentities.value.filter((item) => item !== identity)
    : [...enlargedIdentities.value, identity];
  stageDismissed.value = enlargedIdentities.value.length === 0;
  if (focusedIdentity.value && !enlargedIdentities.value.includes(focusedIdentity.value)) focusedIdentity.value = null;
  if (!enlargedIdentities.value.length) membersExpanded.value = false;
}

function toggleFocusedParticipant(identity: string) {
  releaseViewerLock();
  if (focusedIdentity.value !== identity) membersExpanded.value = false;
  focusedIdentity.value = focusedIdentity.value === identity ? null : identity;
}

function toggleMembersExpanded() {
  releaseViewerLock();
  // 动画期间锁定主画面高度，成员区与聊天区交换空间时不让视频抖动。
  lockedViewerHeight.value = viewerGrid.value?.getBoundingClientRect().height ?? null;
  membersExpanded.value = !membersExpanded.value;
  viewerUnlockTimer = setTimeout(() => { lockedViewerHeight.value = null; viewerUnlockTimer = null; }, 200);
}

function previewGroup(groupId: string) {
  const changed = selectedGroupId.value !== groupId;
  if (changed) releaseViewerLock();
  selectedGroupId.value = groupId;
  if (changed) selectedGroupDetail.value = null;
  if (changed) void refreshGroups();
  else void loadGroup(groupId);
  pendingSwitchGroupId.value = null;
  if (changed) {
    enlargedIdentities.value = [];
    stageDismissed.value = false;
    focusedIdentity.value = null;
    membersExpanded.value = false;
  }
  viewerNotice.value = '';
  volumeOpen.value = false;
}
function participantListening(participant: Participant) {
  return participant === localParticipant.value ? listening.value
    : participant.attributes['lycansync.listening'] !== 'false';
}

</script>

<template>
  <div class="app-shell">
    <header class="titlebar" :class="{ 'desktop-titlebar': desktop }">
      <div class="brand">LycanSync</div>
      <div v-if="desktop" class="window-actions">
        <button aria-label="最小化窗口" @click="desktop.minimize()"><Minus :size="14" /></button>
        <button :aria-label="windowMaximized ? '还原窗口' : '最大化窗口'" @click="desktop.toggleMaximize()">
          <Copy v-if="windowMaximized" :size="14" /><Square v-else :size="14" />
        </button>
        <button aria-label="关闭窗口" @click="desktop.close()"><X :size="14" /></button>
      </div>
      <div v-else class="window-actions" aria-hidden="true"><span><Minus :size="14" /></span><span><Square :size="11" /></span><span><X :size="14" /></span></div>
    </header>
    <div v-if="rtc.notice || viewerNotice" class="notice" role="alert">{{ rtc.notice || viewerNotice }}</div>
    <div class="workspace">
      <nav class="group-rail" aria-label="群组">
        <button v-for="group in groups" :key="group.id" type="button" class="group-button"
          :class="{ 'is-selected': selectedGroupId === group.id, 'is-in-call': joinedGroupId === group.id }"
          :aria-label="`${group.name}，单击预览，双击加入语音`" :aria-pressed="selectedGroupId === group.id"
          :data-tooltip="`${group.name} · 单击预览 / 双击加入`"
          @click="previewGroup(group.id)" @dblclick="requestJoin(group.id)" @keydown.enter.prevent="requestJoin(group.id)">
          <img v-if="group.avatar" :src="group.avatar" class="group-rail-avatar" alt="" />
          <span v-else>{{ group.name.slice(0, 1) }}</span>
          <span v-if="joinedGroupId === group.id" class="group-call-dot" aria-hidden="true" />
        </button>
        <div class="rail-spacer" />
        <button class="group-button add-group" type="button" aria-label="创建群组" data-tooltip="创建群组" @click="openEditor"><Plus :size="17" /></button>
        <button class="group-button profile-button" type="button" aria-label="个人设置" data-tooltip="个人设置" @click="emit('profile')"><img v-if="user.avatar" :src="user.avatar" class="profile-avatar" alt="" referrerpolicy="no-referrer" /><UserRound v-else :size="17" /></button>
      </nav>
      <main v-if="selectedGroup" class="group-main">
        <header class="group-header">
          <div class="group-copy">
            <div class="group-title-row"><h1>{{ selectedGroup.name }}</h1></div>
            <p v-if="selectedGroup.description">{{ selectedGroup.description }}</p>
            <small>单击头像预览 · 双击或按 Enter 加入语音</small>
          </div>
          <IconButton :label="joinedGroupId === selectedGroup.id ? '离开当前群组语音' : '加入当前群组语音'"
            :class="{ 'is-danger': joinedGroupId === selectedGroup.id }" :disabled="joiningGroupId !== null"
            @click="joinedGroupId === selectedGroup.id ? leaveVoice() : requestJoin(selectedGroup.id)">
            <LogOut v-if="joinedGroupId === selectedGroup.id" :size="18" /><Headphones v-else :size="18" />
          </IconButton>
        </header>
        <div v-if="pendingSwitchGroup && joinedGroup" class="switch-confirm" role="alert">
          <span>从“{{ joinedGroup.name }}”切换到“{{ pendingSwitchGroup.name }}”？当前共享会停止，加入后默认开麦。</span>
          <button type="button" @click="pendingSwitchGroupId = null">取消</button>
          <button type="button" class="confirm-button" @click="joinGroup(pendingSwitchGroup.id)">切换</button>
        </div>
        <p v-if="summaryError" class="group-error" role="status">{{ summaryError }}</p>
        <section v-if="!showingJoinedGroup && roomSummary && roomSummary.participantCount > 0" class="voice-preview" aria-label="当前语音成员预览">
          <div class="voice-heading"><span><AudioLines :size="15" />语音中</span><small data-testid="room-summary-count">{{ roomSummary.participantCount }} 人</small></div>
          <div class="voice-preview-list">
            <span v-for="member in roomSummary.participants" :key="member.participantIdentity" class="voice-preview-member">
              <img v-if="previewParticipantAvatar(member.participantIdentity)" :src="previewParticipantAvatar(member.participantIdentity)" alt="" />
              <i v-else aria-hidden="true">{{ previewParticipantName(member.participantIdentity, member.displayName).slice(0, 1) }}</i>
              <strong>{{ previewParticipantName(member.participantIdentity, member.displayName) }}</strong>
            </span>
          </div>
        </section>
        <section v-if="showingJoinedGroup && groupParticipants.length > 0" class="voice-panel"
          :class="{ 'has-sharing': hasStage, 'members-expanded': hasStage && membersExpanded && !focusedOnSelectedGroup, 'is-focused': focusedOnSelectedGroup }" aria-label="当前语音成员">
          <div class="voice-heading">
            <span><AudioLines :size="15" />语音中</span>
            <span class="voice-heading-actions">
              <small data-testid="member-count">{{ groupParticipants.length }} 人 · {{ sharingParticipants.length }} / 8 路共享</small>
            </span>
          </div>
          <div v-if="hasStage" ref="viewerGrid" class="viewer-grid" :class="`viewer-count-${displayedParticipants.length}`"
            :style="lockedViewerHeight === null ? undefined : { flex: `0 0 ${lockedViewerHeight}px` }">
            <ParticipantCard v-for="participant in displayedParticipants" :key="participant.identity" :participant="participant"
              :revision="rtc.revision" :avatar="participantAvatar(participant.identity)" :is-local="participant === localParticipant" :is-listening="participantListening(participant)"
              variant="viewer" :focused="focusedOnSelectedGroup" @focus="toggleFocusedParticipant(participant.identity)" @notice="viewerNotice = $event" />
          </div>
          <div v-else class="participant-grid">
            <ParticipantCard v-for="participant in groupParticipants" :key="participant.identity" :participant="participant"
              :revision="rtc.revision" :avatar="participantAvatar(participant.identity)" :is-local="participant === localParticipant" :is-listening="participantListening(participant)"
              @select="toggleEnlargedParticipant(participant.identity)" />
          </div>
          <div v-if="hasStage && !focusedOnSelectedGroup" class="member-strip-divider">
            <button type="button" :aria-label="membersExpanded ? '收起其他成员' : '展开其他成员'"
              class="icon-button member-strip-toggle" :class="{ 'is-expanded': membersExpanded }" @click="toggleMembersExpanded">
              <UsersRound :size="15" /><ChevronDown :size="13" class="toggle-chevron" />
            </button>
          </div>
          <Transition name="member-strip">
            <div v-if="hasStage && membersExpanded && !focusedOnSelectedGroup" class="filmstrip-row">
              <button v-if="filmstripPageCount > 1" type="button" class="filmstrip-page-button" aria-label="上一页成员" :disabled="filmstripPage === 0" @click="filmstripPage--"><ChevronLeft :size="17" /></button>
              <div class="member-filmstrip" data-testid="member-filmstrip">
                <ParticipantCard v-for="participant in filmstripParticipants" :key="participant.identity" :participant="participant"
                  :revision="rtc.revision" :avatar="participantAvatar(participant.identity)" :is-local="participant === localParticipant" :is-listening="participantListening(participant)"
                  variant="thumbnail" :selected="enlargedIdentities.includes(participant.identity)"
                  @select="toggleEnlargedParticipant(participant.identity)" />
              </div>
              <button v-if="filmstripPageCount > 1" type="button" class="filmstrip-page-button" aria-label="下一页成员" :disabled="filmstripPage >= filmstripPageCount - 1" @click="filmstripPage++"><ChevronRight :size="17" /></button>
            </div>
          </Transition>
        </section>
        <section v-if="!focusedOnSelectedGroup" class="chat-panel" :aria-label="`${selectedGroup.name}群聊`">
          <div class="chat-heading"><MessageSquareText :size="15" /><span>群聊</span></div>
          <div class="message-list"></div>
          <div class="composer"><button type="button" disabled aria-label="添加内容"><Plus :size="16" /></button>
            <input aria-label="消息内容" disabled placeholder="发送消息" />
            <button type="button" disabled aria-label="发送消息"><Send :size="15" /></button>
          </div>
        </section>
        <div v-if="callbarGroup || joiningGroupId" class="callbar-reveal" :class="{ 'is-leaving': callbarLeaving }" data-testid="callbar">
          <div class="callbar-content">
            <footer class="callbar">
              <div class="call-state" role="status">
                <RadioTower v-if="callbarGroup" :size="17" /><Headphones v-else :size="17" />
                <span><strong>{{ STATUS_LABELS[rtc.status] }}</strong>
                  <small>{{ callbarGroup ? callbarGroup.name + (selectedGroupId !== callbarGroup.id ? ' · 正在浏览 ' + selectedGroup.name : '') : '预览群组不会请求麦克风' }}</small>
                </span>
              </div>
              <IconButton v-if="joinedGroup && selectedGroupId !== joinedGroup.id" label="返回当前通话群组" @click="previewGroup(joinedGroup.id)"><CornerUpLeft :size="17" /></IconButton>
              <IconButton :label="localParticipant?.isMicrophoneEnabled ? '关闭麦克风' : '开启麦克风'" :class="{ 'is-off': !localParticipant?.isMicrophoneEnabled }"
                :disabled="!connected || rtc.busySources.includes(Track.Source.Microphone)" @click="toggleMicrophone">
                <Mic v-if="localParticipant?.isMicrophoneEnabled" :size="17" /><MicOff v-else :size="17" />
              </IconButton>
              <IconButton :label="rtc.needsAudioPlayback ? '允许播放声音' : listening ? '停止接收声音' : '恢复接收声音'"
                :class="{ 'is-active': listening, 'is-off': !listening }" :disabled="!connected || rtc.busySources.includes(Track.Source.Microphone)" @click="toggleListening">
                <Headphones v-if="listening && volume > 0" :size="17" /><HeadphoneOff v-else :size="17" />
              </IconButton>
              <IconButton label="调整本机接收音量" :disabled="!connected" :class="{ 'is-active': volumeOpen }" @click="volumeOpen = !volumeOpen"><SlidersHorizontal :size="17" /></IconButton>
              <IconButton :label="localParticipant?.isScreenShareEnabled ? '停止屏幕共享' : screenShareLimitReached ? '屏幕共享已达到 8 路上限' : '开始屏幕共享'"
                :class="{ 'is-active': localParticipant?.isScreenShareEnabled }"
                :disabled="!connected || screenShareLimitReached || rtc.busySources.includes(Track.Source.ScreenShare)"
                @click="rtc.toggleMedia(Track.Source.ScreenShare)"><MonitorUp :size="17" /></IconButton>
              <IconButton :label="joiningGroupId ? '取消连接' : '离开语音'" class="is-danger" :disabled="!joinedGroup && joiningGroupId === null" @click="leaveVoice"><LogOut :size="17" /></IconButton>
              <div v-if="volumeOpen && connected" class="volume-popover">
                <Headphones v-if="listening && volume > 0" :size="17" /><HeadphoneOff v-else :size="17" />
                <input type="range" min="0" max="1" step="0.05" :value="volume"
                  @input="updateVolume(Number(($event.target as HTMLInputElement).value))" aria-label="本机接收音量" />
                <span>{{ Math.round(volume * 100) }}%</span>
              </div>
            </footer>
          </div>
        </div>
      </main>
      <main v-else class="group-main group-empty">
        <p v-if="groupError" role="alert">{{ groupError }}</p>
        <p v-else>还没有群组，点击左侧的 + 创建一个开黑小队。</p>
      </main>
      <aside class="members-panel" aria-label="群组成员">
        <div class="members-header"><strong>成员<span v-if="selectedGroupDetail"> · {{ selectedGroupDetail.memberCount }}</span></strong>
        </div>
        <p v-if="groupError" role="alert" class="group-error">{{ groupError }}</p>
        <p v-else-if="groupLoading" class="group-hint">正在读取成员…</p>
        <div v-for="member in selectedGroupDetail?.members ?? []" :key="member.userId" class="group-member-row">
          <img v-if="member.userId === user.id ? user.avatar : member.avatar" :src="member.userId === user.id ? user.avatar : member.avatar" alt="" />
          <span v-else class="group-member-initial">{{ member.nickname.slice(0, 1) }}</span>
          <span class="group-member-name">{{ member.userId === user.id ? user.nickname : member.nickname }}</span>
          <small v-if="member.role === 'OWNER'">群主</small>
        </div>
      </aside>
    </div>
    <div v-if="editorOpen" class="dialog-backdrop" @keydown.esc="!formBusy && !formAvatarFile && (editorOpen = false)">
      <form class="group-dialog" role="dialog" aria-modal="true" aria-label="创建群组" :inert="Boolean(formAvatarFile)" @submit.prevent="submitEditor">
        <h2>创建群组</h2>
        <div class="group-avatar-settings">
          <div class="group-avatar-preview" aria-label="群组头像预览">
            <img v-if="formAvatar" :src="formAvatar" alt="" />
            <UsersRound v-else :size="28" />
          </div>
          <div class="group-avatar-actions">
            <input ref="groupAvatarInput" type="file" hidden aria-label="上传群组头像" accept="image/png,image/jpeg" @change="pickGroupAvatar" />
            <button type="button" :disabled="formBusy" @click="groupAvatarInput?.click()">选择头像</button>
            <button v-if="formAvatar" type="button" :disabled="formBusy" @click="formAvatar = ''">移除头像</button>
            <small>可选 PNG/JPEG，支持裁剪；原图不超过 10 MB。</small>
          </div>
        </div>
        <label>群组名称
          <input v-model="formName" required maxlength="32" autocomplete="off" />
        </label>
        <label>群组描述（可选）
          <textarea v-model="formDescription" maxlength="200" rows="3" />
        </label>
        <p v-if="formError" role="alert" class="group-error">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="formBusy" @click="editorOpen = false">取消</button>
          <button type="submit" :disabled="formBusy || Boolean(formAvatarFile) || !formName.trim()">{{ formBusy ? '请稍候…' : '确定' }}</button>
        </div>
      </form>
    </div>
    <AvatarCropDialog v-if="formAvatarFile" :file="formAvatarFile" title="调整群组头像"
      @apply="(avatar) => { formAvatar = avatar; formAvatarFile = null; }" @cancel="formAvatarFile = null" />
    <div v-if="captureRequest" class="dialog-backdrop" @keydown.esc="selectCaptureSource(null)">
      <section class="capture-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-title">
        <h2 id="capture-title">选择共享的窗口或屏幕</h2>
        <p>只共享画面，不包含系统声音。请选择不含私人信息的窗口。</p>
        <div class="capture-sources">
          <button v-for="source in captureRequest.sources" :key="source.id" @click="selectCaptureSource(source.id)">
            <img :src="source.thumbnail" alt="" /><span>{{ source.name }}</span>
          </button>
        </div>
        <p v-if="!captureRequest.sources.length">没有可共享的窗口或屏幕，请检查系统权限后重试。</p>
        <div class="dialog-actions"><button autofocus @click="selectCaptureSource(null)">取消共享</button></div>
      </section>
    </div>
    <RemoteAudio v-for="track in remoteAudioTracks" :key="track.sid" :track="track" :volume="listening ? volume : 0" />
  </div>
</template>
