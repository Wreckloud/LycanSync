<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, reactive, ref, watch } from 'vue';
import { Activity, AudioLines, ChevronDown, ChevronLeft, ChevronRight, Copy, CornerUpLeft, Gamepad2, Headphones,
  LogOut, MicOff, Minus, MonitorUp, Plus, RadioTower,
  Settings, Square, UserRound, UsersRound, Volume2, X } from '@lucide/vue';
import { RemoteAudioTrack, Track, type Participant } from 'livekit-client';
import ParticipantCard from './components/ParticipantCard.vue';
import VoiceLevelMic from './components/VoiceLevelMic.vue';
import MediaDiagnostics from './components/MediaDiagnostics.vue';
import RemoteAudio from './components/RemoteAudio.vue';
import IconButton from './components/IconButton.vue';
import GlobalTooltip from './components/GlobalTooltip.vue';
import AvatarCropDialog from './components/AvatarCropDialog.vue';
import GroupChat from './components/GroupChat.vue';
import { createGroup, findGroup, findGroupPresences, findGroups,
  type GroupDetail, type GroupMember, type GroupPresence, type GroupSummary } from './group/groupApi';
import { useRtcRoom } from './rtc/useRtcRoom';
import { createNativeVideoSourceSelection } from './components/nativeVideoSourceSelection';
import { useRoomSummary } from './rtc/useRoomSummary';
import { requestRoomOccupancies } from './rtc/roomSummaryApi';
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP, type AudioProcessingSettings } from './rtc/audioPreferences';
import { useAudioPreferences, type AudioVolumeChange } from './rtc/useAudioPreferences';
import { entranceSoundToFile, loadEntranceSound } from './rtc/entranceSound';
import { useCallSounds } from './rtc/useCallSounds';
import { normalizeVoiceLevel } from './rtc/voiceLevel';
import { sendPresenceHeartbeat, type UserActivity, type UserPresenceStatus } from './presence/presenceApi';
import type { AuthUser } from './auth/authApi';

const props = defineProps<{ user: AuthUser; windowMaximized: boolean }>();
const emit = defineEmits<{ profile: [] }>();

const STATUS_LABELS = { idle: '未加入语音', joining: '正在连接', connected: '语音已连接', reconnecting: '正在重连' };
const CALLBAR_EXIT_DURATION_MS = 180;
const GROUP_LIST_REFRESH_INTERVAL_MS = 30_000;
const GROUP_REALTIME_REFRESH_INTERVAL_MS = 15_000;
const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
const PRESENCE_IDLE_TIMEOUT_MS = 5 * 60_000;
const PRESENCE_IDLE_CHECK_INTERVAL_MS = 15_000;
const ACTIVITY_CLOCK_INTERVAL_MS = 10_000;
const INPUT_LEVEL_SEGMENTS = 16;
const LAST_SEEN_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const PRESENCE_STATUS_LABELS: Record<UserPresenceStatus, string> = {
  ONLINE: '在线',
  AWAY: '离开',
  OFFLINE: '离线',
};
const audioPreferences = useAudioPreferences(props.user.id);
const { inputGain, outputVolume, screenShareVolume, processing: audioProcessing } = audioPreferences;
const callSounds = useCallSounds(outputVolume);
const desktop = window.lycanDesktop;
const captureRequest = ref<CaptureRequest | null>(null);
const captureSourceType = ref<'window' | 'screen'>('window');
const captureAudioAvailable = ref(false);
const captureShareAudio = ref(true);
type NativeScreenSourceSelection = { sourceId: string; shareAudio: boolean };
let resolveNativeSourceSelection: ((selection: NativeScreenSourceSelection | null) => void) | undefined;
const captureSources = computed(() => captureRequest.value?.sources
  .filter((source) => source.type === captureSourceType.value) ?? []);
function selectCaptureSource(sourceId: string | null) {
  const request = captureRequest.value;
  if (!request) return;
  captureRequest.value = null;
  if (request.native) {
    const resolveSelection = resolveNativeSourceSelection;
    resolveNativeSourceSelection = undefined;
    resolveSelection?.(sourceId ? { sourceId, shareAudio: captureShareAudio.value } : null);
    return;
  }
  if (sourceId === null) rtc.cancelPendingScreenShareSelection();
  desktop?.selectSource(request.requestId, sourceId);
}
async function requestNativeScreenSource(sources: NativeVideoSource[]): Promise<NativeScreenSourceSelection | null> {
  selectCaptureSource(null);
  const capabilities = await desktop?.getNativeMediaCapabilities().catch(() =>
    ({} as Record<string, { available: boolean; reason: string }>)) ?? {};
  captureAudioAvailable.value = capabilities.screenShareAudioCapture?.available === true;
  captureShareAudio.value = captureAudioAvailable.value;
  const thumbnails = await desktop?.getNativeVideoSourceThumbnails(sources).catch(() => []) ?? [];
  const selection = createNativeVideoSourceSelection(sources, thumbnails);
  resolveNativeSourceSelection = selection.finish;
  captureSourceType.value = sources.some((source) => source.kind === 'window') ? 'window' : 'screen';
  captureRequest.value = {
    requestId: `native-${Date.now()}`,
    native: true,
    sources: selection.options,
  };
  return selection.result;
}
const rtc = reactive(useRtcRoom({
  inputGain: inputGain.value,
  processing: audioProcessing,
  events: {
    participantJoined: callSounds.participantJoined,
    participantLeft: callSounds.participantLeft,
    participantEntrancePending: callSounds.participantEntrancePending,
    participantEntranceFailed: callSounds.participantEntranceFailed,
    participantEntranceSound: (identity, bytes) => { void callSounds.participantEntranceSound(identity, bytes); },
    screenShareStarted: callSounds.screenShareStarted,
    screenShareStopped: callSounds.screenShareStopped,
    disconnected: callSounds.left,
    selectNativeScreenSource: requestNativeScreenSource,
  },
}));
// 预先恢复被静音成员的订阅策略；之后只有跨越 0% 时才更新网络订阅。
audioPreferences.mutedParticipantIdentities()
  .forEach((identity) => rtc.setRemoteAudioSubscribed(identity, false));
const removeCaptureListener = desktop?.onSources((request) => {
  captureSourceType.value = request.sources.some((source) => source.type === 'window') ? 'window' : 'screen';
  captureRequest.value = request;
});
const removeCloseListener = desktop?.onClose(async () => {
  selectCaptureSource(null);
  try { await rtc.leave(); }
  finally { desktop.finishClose(); }
});
onScopeDispose(() => {
  selectCaptureSource(null); removeCaptureListener?.(); removeCloseListener?.();
  detailRequest?.abort(); listRequest?.abort(); void rtc.leave();
});
watch(() => rtc.status, (status) => { if (status === 'idle') selectCaptureSource(null); });
const groups = ref<GroupSummary[]>([]);
const selectedGroupId = ref<string | null>(null);
const selectedGroupDetail = ref<GroupDetail | null>(null);
const joinedGroupDetail = ref<GroupDetail | null>(null);
const groupPresences = ref<Record<string, GroupPresence>>({});
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
let groupPresenceRequest: AbortController | null = null;
let roomOccupancyRequest: AbortController | null = null;
let joinAttempt = 0;
let presenceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let presenceIdleTimer: ReturnType<typeof setInterval> | null = null;
let activityClockTimer: ReturnType<typeof setInterval> | null = null;
let presenceAbort: AbortController | null = null;
const currentPresenceStatus = ref<UserPresenceStatus>('ONLINE');
const currentActivity = ref<(UserActivity & { startedAt: string }) | null>(null);
const activityClock = ref(Date.now());

function applyDetectedActivity(activity: DetectedActivity | null) {
  if (JSON.stringify(activity) === JSON.stringify(currentActivity.value)) return;
  currentActivity.value = activity;
  void sendHeartbeat();
}
const removeActivityListener = desktop?.onActivityChange(applyDetectedActivity);
void desktop?.getCurrentActivity().then(applyDetectedActivity).catch(() => undefined);
onScopeDispose(() => removeActivityListener?.());

async function sendHeartbeat() {
  presenceAbort?.abort();
  const controller = new AbortController();
  presenceAbort = controller;
  try {
    const activity = currentActivity.value
      ? { type: currentActivity.value.type, name: currentActivity.value.name }
      : null;
    await sendPresenceHeartbeat(currentPresenceStatus.value, activity, controller.signal);
  } catch {
    // 心跳失败不阻塞 UI；下一次周期再试。
  }
}

function startPresenceHeartbeat() {
  if (presenceHeartbeatTimer) return;
  void sendHeartbeat();
  presenceHeartbeatTimer = setInterval(() => void sendHeartbeat(), PRESENCE_HEARTBEAT_INTERVAL_MS);
}

function stopPresenceHeartbeat() {
  presenceAbort?.abort();
  if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);
  presenceHeartbeatTimer = null;
}

async function updateOwnPresenceStatus() {
  const systemIdle = await desktop?.getSystemIdleState().catch(() => null);
  const nextStatus = systemIdle && (systemIdle.state === 'idle' || systemIdle.state === 'locked'
    || systemIdle.idleSeconds >= PRESENCE_IDLE_TIMEOUT_MS / 1000) ? 'AWAY' : 'ONLINE';
  if (nextStatus === currentPresenceStatus.value) return;
  currentPresenceStatus.value = nextStatus;
  void sendHeartbeat();
}

async function refreshGroupPresences(groupId: string) {
  groupPresenceRequest?.abort();
  const request = new AbortController();
  groupPresenceRequest = request;
  try {
    const result = await findGroupPresences(groupId, request.signal);
    if (!request.signal.aborted && selectedGroupId.value === groupId) {
      groupPresences.value = Object.fromEntries(result.map((presence) => [presence.userId, presence]));
    }
  } catch {
    // 在线状态短暂失效时保留最后一次结果，不覆盖群组资料错误。
  }
}

const roomOccupancies = ref<Record<string, number>>({});
async function refreshRoomOccupancies() {
  roomOccupancyRequest?.abort();
  const request = new AbortController();
  roomOccupancyRequest = request;
  try {
    const result = await requestRoomOccupancies(request.signal);
    if (!request.signal.aborted) {
      roomOccupancies.value = Object.fromEntries(result.map((room) => [room.groupId, room.participantCount]));
    }
  } catch {
    // RTC 摘要短暂不可用时保留最后一次人数，避免徽标闪烁。
  }
}

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
      void refreshGroupPresences(groupId);
    }
  } catch (error) {
    if (!request.signal.aborted) groupError.value = error instanceof Error ? error.message : '无法读取群组资料';
  } finally {
    if (!request.signal.aborted) groupLoading.value = false;
  }
}

async function refreshGroups(refreshDetail = true, refreshOccupancy = true) {
  listRequest?.abort();
  const request = new AbortController();
  listRequest = request;
  try {
    const result = await findGroups(request.signal);
    if (request.signal.aborted) return;
    groups.value = result;
    if (result.length > 0 && refreshOccupancy) void refreshRoomOccupancies();
    else if (result.length === 0) {
      roomOccupancyRequest?.abort();
      roomOccupancies.value = {};
    }
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
let groupListRefreshTimer: ReturnType<typeof setInterval> | null = null;
let groupRealtimeRefreshTimer: ReturnType<typeof setInterval> | null = null;
let lastActivationRefreshAt = 0;
function refreshOnActivation() {
  if (document.visibilityState === 'hidden' || Date.now() - lastActivationRefreshAt < 500) return;
  lastActivationRefreshAt = Date.now();
  void refreshGroups();
}
function handleVisibilityChange() {
  refreshOnActivation();
}
onMounted(() => {
  void updateOwnPresenceStatus();
  refreshOnActivation();
  startPresenceHeartbeat();
  window.addEventListener('focus', refreshOnActivation);
  window.addEventListener('resize', remeasureViewerHeight);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  presenceIdleTimer = setInterval(() => void updateOwnPresenceStatus(), PRESENCE_IDLE_CHECK_INTERVAL_MS);
  activityClockTimer = setInterval(() => { activityClock.value = Date.now(); }, ACTIVITY_CLOCK_INTERVAL_MS);
  groupListRefreshTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void refreshGroups(false, false);
  }, GROUP_LIST_REFRESH_INTERVAL_MS);
  groupRealtimeRefreshTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') {
      if (groups.value.length > 0) void refreshRoomOccupancies();
      if (selectedGroupId.value) void refreshGroupPresences(selectedGroupId.value);
    }
  }, GROUP_REALTIME_REFRESH_INTERVAL_MS);
});
onScopeDispose(() => {
  window.removeEventListener('focus', refreshOnActivation);
  window.removeEventListener('resize', remeasureViewerHeight);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  groupPresenceRequest?.abort();
  roomOccupancyRequest?.abort();
  stopPresenceHeartbeat();
  if (presenceIdleTimer) clearInterval(presenceIdleTimer);
  if (activityClockTimer) clearInterval(activityClockTimer);
  if (groupListRefreshTimer) clearInterval(groupListRefreshTimer);
  if (groupRealtimeRefreshTimer) clearInterval(groupRealtimeRefreshTimer);
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
const enlargedIdentities = ref<string[]>([]);
const stageDismissed = ref(false);
const focusedIdentity = ref<string | null>(null);
const membersExpanded = ref(false);
const filmstripPage = ref(0);
const viewerGrid = ref<HTMLElement | null>(null);
const lockedViewerHeight = ref<number | null>(null);
const viewerNotice = ref('');
const diagnosticsPinned = ref(false);
const diagnosticsHovered = ref(false);
const diagnosticsOpen = computed(() => diagnosticsPinned.value || diagnosticsHovered.value);
const departingGroupId = ref<string | null>(null);
const callbarLeaving = ref(false);
let listeningSync: Promise<void> | null = null;
let diagnosticsHoverTimer: ReturnType<typeof setTimeout> | null = null;
function releaseViewerLock() {
  lockedViewerHeight.value = null;
}
function showDiagnosticsPreview() {
  if (diagnosticsHoverTimer) clearTimeout(diagnosticsHoverTimer);
  diagnosticsHovered.value = true;
}
function hideDiagnosticsPreview() {
  if (diagnosticsHoverTimer) clearTimeout(diagnosticsHoverTimer);
  diagnosticsHoverTimer = setTimeout(() => { diagnosticsHovered.value = false; }, 100);
}
onScopeDispose(() => {
  if (diagnosticsHoverTimer) clearTimeout(diagnosticsHoverTimer);
  releaseViewerLock();
});

const selectedGroup = computed(() => groups.value.find((group) => group.id === selectedGroupId.value) ?? null);
const joinedGroup = computed(() => groups.value.find((group) => group.id === joinedGroupId.value) ?? null);
const callbarGroup = computed(() => joinedGroup.value ?? groups.value.find((group) => group.id === departingGroupId.value) ?? null);
const pendingSwitchGroup = computed(() => groups.value.find((group) => group.id === pendingSwitchGroupId.value) ?? null);
const localParticipant = computed(() => rtc.room?.localParticipant);
const localMicrophoneLevel = computed(() => {
  void rtc.revision;
  const participant = localParticipant.value;
  return participant?.isMicrophoneEnabled && participant.isSpeaking ? participant.audioLevel : 0;
});
const localInputLevel = computed(() => {
  void rtc.revision;
  const participant = localParticipant.value;
  return participant?.isMicrophoneEnabled ? normalizeVoiceLevel(participant.audioLevel) : 0;
});
const localInputLevelPercent = computed(() => Math.round(localInputLevel.value * 100));
const connected = computed(() => rtc.status === 'connected');
const showingJoinedGroup = computed(() => joinedGroupId.value !== null && selectedGroupId.value === joinedGroupId.value);
const roomSummary = useRoomSummary(selectedGroupId, computed(() => !showingJoinedGroup.value),
  (message) => { summaryError.value = message; });
const groupHasVoiceActivity = (groupId: string) => joinedGroupId.value === groupId
  || (roomOccupancies.value[groupId] ?? 0) > 0;
const currentMembers = computed(() => joinedGroupDetail.value?.members ?? []);
const memberOnlineStatus = (member: GroupMember) => {
  if (member.userId === props.user.id) return currentPresenceStatus.value;
  return groupPresences.value[member.userId]?.status ?? 'OFFLINE';
};
const memberActivity = (member: GroupMember) => {
  const activity = member.userId === props.user.id
    ? currentActivity.value
    : groupPresences.value[member.userId]?.activityType === 'GAME'
      && groupPresences.value[member.userId]?.activityName
      && groupPresences.value[member.userId]?.activityStartedAt
      ? { type: 'GAME' as const, name: groupPresences.value[member.userId].activityName!,
          startedAt: groupPresences.value[member.userId].activityStartedAt! }
      : null;
  if (memberOnlineStatus(member) === 'OFFLINE' || !activity) return null;
  return `正在玩 ${activity.name} · ${formatActivityDuration(activity.startedAt)}`;
};
const orderedMembers = computed(() => {
  const members = selectedGroupDetail.value?.members ?? [];
  return [...members.filter((member) => memberOnlineStatus(member) !== 'OFFLINE'),
    ...members.filter((member) => memberOnlineStatus(member) === 'OFFLINE')];
});
function formatActivityDuration(startedAt: string) {
  const elapsedSeconds = Math.max(0, Math.floor((activityClock.value - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
const memberStatusLabel = (member: GroupMember) => {
  const status = memberOnlineStatus(member);
  const activity = memberActivity(member);
  const label = PRESENCE_STATUS_LABELS[status] ?? PRESENCE_STATUS_LABELS.OFFLINE;
  return activity ? `${label} · ${activity}` : label;
};
const memberLastSeenTooltip = (member: GroupMember) => {
  if (memberOnlineStatus(member) !== 'OFFLINE') return undefined;
  const lastSeenAt = groupPresences.value[member.userId]?.lastSeenAt;
  const timestamp = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  return Number.isFinite(timestamp)
    ? `最后在线：${LAST_SEEN_DATE_TIME_FORMATTER.format(timestamp)}`
    : '最后在线：暂无记录';
};
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
watch(() => rtc.room, (room) => {
  if (room) return;
  diagnosticsPinned.value = false;
  diagnosticsHovered.value = false;
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
  .flatMap((participant) => ([
    { participantIdentity: participant.identity, source: Track.Source.Microphone,
      track: participant.getTrackPublication(Track.Source.Microphone)?.track },
    { participantIdentity: participant.identity, source: Track.Source.ScreenShareAudio,
      track: participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track },
  ]))
  .filter((item): item is { participantIdentity: string; source: Track.Source; track: RemoteAudioTrack } =>
    item.track instanceof RemoteAudioTrack));
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
  callbarLeaving.value = false;
  departingGroupId.value = null;

  if (joinedGroupId.value !== null) {
    void callSounds.left();
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
    void callSounds.joined();
    const entranceSound = loadEntranceSound(props.user.id);
    if (entranceSound) {
      try { void rtc.sendEntranceSound(entranceSoundToFile(entranceSound)); }
      catch { viewerNotice.value = '本机保存的入场音效已损坏，请在个人设置中重新选择。'; }
    }
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
  if (rtc.status === 'connected' || rtc.status === 'reconnecting') void callSounds.left();
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
  void refreshGroups();
}

async function toggleMicrophone() {
  if (!connected.value || !localParticipant.value) return;
  const shouldEnableMicrophone = !localParticipant.value.isMicrophoneEnabled;
  if (shouldEnableMicrophone && !listening.value) {
    listening.value = true;
    await synchronizeListeningState();
    return;
  }
  await rtc.setMediaEnabled(Track.Source.Microphone, shouldEnableMicrophone);
}

function synchronizeListeningState() {
  if (!connected.value) return Promise.resolve();
  if (listeningSync) return listeningSync;
  // 连续点击可能让异步开关交错；串行追赶最后状态，避免旧请求覆盖新状态。
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
  listening.value = !listening.value;
  await synchronizeListeningState();
}

function participantVolume(identity: string) {
  return audioPreferences.participantVolume(identity);
}

function synchronizeParticipantSubscription(identity: string, change: AudioVolumeChange | null) {
  if (change && (change.previous > 0) !== (change.current > 0)) {
    rtc.setRemoteAudioSubscribed(identity, change.current > 0);
  }
}

function updateParticipantVolume(identity: string, volume: number) {
  synchronizeParticipantSubscription(identity, audioPreferences.setParticipantVolume(identity, volume));
}

function toggleParticipantAudio(identity: string) {
  synchronizeParticipantSubscription(identity, audioPreferences.toggleParticipantVolume(identity));
}

function updateInputGain(volume: number) {
  if (audioPreferences.setInputGain(volume)) rtc.setMicrophoneInputGain(inputGain.value);
}

function updateOutputVolume(volume: number) {
  audioPreferences.setOutputVolume(volume);
}
function updateScreenShareVolume(volume: number) {
  audioPreferences.setScreenShareVolume(volume);
}

function updateAudioProcessing(setting: keyof AudioProcessingSettings, enabled: boolean) {
  if (audioPreferences.setProcessing(setting, enabled)) void rtc.setMicrophoneProcessing(audioProcessing);
}

function remotePlaybackVolume(identity: string) {
  return Math.min(AUDIO_VOLUME_MAX, participantVolume(identity) * outputVolume.value);
}
function remoteScreenSharePlaybackVolume() {
  return Math.min(AUDIO_VOLUME_MAX, screenShareVolume.value * outputVolume.value);
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
  if (!membersExpanded.value) {
    // 下方成员条展开时只占用聊天区空间，主观看区保持当前高度。
    lockedViewerHeight.value = viewerGrid.value?.getBoundingClientRect().height ?? null;
  }
  membersExpanded.value = !membersExpanded.value;
}

function remeasureViewerHeight() {
  if (!hasStage.value || !viewerGrid.value) return;
  // 窗口变化后先让 flex 按当前展开状态重新排版，再锁定新的舞台高度。
  lockedViewerHeight.value = null;
  void nextTick(() => {
    if (hasStage.value && viewerGrid.value) {
      lockedViewerHeight.value = viewerGrid.value.getBoundingClientRect().height;
    }
  });
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
          :aria-label="`${group.name}${groupHasVoiceActivity(group.id) ? '，当前有语音成员' : ''}，单击预览，双击加入语音`" :aria-pressed="selectedGroupId === group.id"
          :data-tooltip="`${group.name} · 单击预览 / 双击加入`"
          @click="previewGroup(group.id)" @dblclick="requestJoin(group.id)" @keydown.enter.prevent="requestJoin(group.id)">
          <img v-if="group.avatar" :src="group.avatar" class="group-rail-avatar" alt="" />
          <span v-else>{{ group.name.slice(0, 1) }}</span>
          <span v-if="groupHasVoiceActivity(group.id)" class="group-call-badge" aria-hidden="true"><Volume2 :size="12" :stroke-width="2.6" /></span>
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
              <span class="diagnostics-control" @mouseenter="showDiagnosticsPreview" @mouseleave="hideDiagnosticsPreview">
                <IconButton label="媒体诊断" tooltip="点击固定" :class="{ 'is-active': diagnosticsPinned }"
                  :aria-pressed="diagnosticsPinned" @click="diagnosticsPinned = !diagnosticsPinned"><Activity :size="15" /></IconButton>
                <Transition name="floating-panel">
                  <MediaDiagnostics v-if="diagnosticsOpen && rtc.room" :room="rtc.room" :participants="groupParticipants"
                    @mouseenter="showDiagnosticsPreview" @mouseleave="hideDiagnosticsPreview" />
                </Transition>
              </span>
            </span>
          </div>
          <div v-if="hasStage" ref="viewerGrid" class="viewer-grid" :class="`viewer-count-${displayedParticipants.length}`"
            :style="lockedViewerHeight === null ? undefined : { flex: `0 0 ${lockedViewerHeight}px` }">
            <ParticipantCard v-for="participant in displayedParticipants" :key="participant.identity" :participant="participant"
              :revision="rtc.revision" :avatar="participantAvatar(participant.identity)" :is-local="participant === localParticipant" :is-listening="participantListening(participant)"
              :playback-volume="participantVolume(participant.identity)" :input-gain="inputGain" :output-volume="outputVolume"
              variant="viewer" :focused="focusedOnSelectedGroup"
              @focus="toggleFocusedParticipant(participant.identity)" @notice="viewerNotice = $event"
              @toggle-audio="toggleParticipantAudio(participant.identity)" @volume-change="updateParticipantVolume(participant.identity, $event)"
              @input-gain-change="updateInputGain" @output-volume-change="updateOutputVolume"
              @toggle-microphone="toggleMicrophone" @toggle-listening="toggleListening" />
          </div>
          <div v-else class="participant-grid">
            <ParticipantCard v-for="participant in groupParticipants" :key="participant.identity" :participant="participant"
              :revision="rtc.revision" :avatar="participantAvatar(participant.identity)" :is-local="participant === localParticipant" :is-listening="participantListening(participant)"
              :playback-volume="participantVolume(participant.identity)" :input-gain="inputGain" :output-volume="outputVolume"
              @select="toggleEnlargedParticipant(participant.identity)"
              @toggle-audio="toggleParticipantAudio(participant.identity)" @volume-change="updateParticipantVolume(participant.identity, $event)"
              @input-gain-change="updateInputGain" @output-volume-change="updateOutputVolume"
              @toggle-microphone="toggleMicrophone" @toggle-listening="toggleListening" />
          </div>
          <div v-if="hasStage && !focusedOnSelectedGroup" class="member-strip-divider">
            <button type="button" :aria-label="membersExpanded ? '收起其他成员' : '展开其他成员'"
              class="icon-button member-strip-toggle" :class="{ 'is-expanded': membersExpanded }" @click="toggleMembersExpanded">
              <ChevronDown :size="17" class="toggle-chevron" />
            </button>
          </div>
          <Transition name="member-strip">
            <div v-if="hasStage && membersExpanded && !focusedOnSelectedGroup" class="filmstrip-row">
              <button v-if="filmstripPageCount > 1" type="button" class="filmstrip-page-button" aria-label="上一页成员"
                :disabled="filmstripPage === 0" @click="filmstripPage--"><ChevronLeft :size="17" /></button>
              <div class="member-filmstrip" data-testid="member-filmstrip">
                <ParticipantCard v-for="participant in filmstripParticipants" :key="participant.identity" :participant="participant"
                  :revision="rtc.revision" :avatar="participantAvatar(participant.identity)" :is-local="participant === localParticipant" :is-listening="participantListening(participant)"
                  :playback-volume="participantVolume(participant.identity)" :input-gain="inputGain" :output-volume="outputVolume"
                  variant="thumbnail" :selected="enlargedIdentities.includes(participant.identity)"
                  @select="toggleEnlargedParticipant(participant.identity)" @toggle-audio="toggleParticipantAudio(participant.identity)"
                  @volume-change="updateParticipantVolume(participant.identity, $event)" @toggle-microphone="toggleMicrophone"
                  @input-gain-change="updateInputGain" @output-volume-change="updateOutputVolume" @toggle-listening="toggleListening" />
              </div>
              <button v-if="filmstripPageCount > 1" type="button" class="filmstrip-page-button" aria-label="下一页成员"
                :disabled="filmstripPage >= filmstripPageCount - 1" @click="filmstripPage++"><ChevronRight :size="17" /></button>
            </div>
          </Transition>
        </section>
        <GroupChat v-if="!focusedOnSelectedGroup" :key="selectedGroup.id" :group="selectedGroup"
          :members="selectedGroupDetail?.members ?? []" :user="user" />
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
              <span class="call-audio-control">
                <IconButton :label="localParticipant?.isMicrophoneEnabled ? '关闭麦克风' : '开启麦克风'" :show-tooltip="false"
                  :class="{ 'is-off': !localParticipant?.isMicrophoneEnabled }"
                  :disabled="!connected || rtc.busySources.includes(Track.Source.Microphone)" @click="toggleMicrophone">
                  <VoiceLevelMic v-if="localParticipant?.isMicrophoneEnabled" :size="17" :level="localMicrophoneLevel" /><MicOff v-else :size="17" />
                </IconButton>
                <section class="audio-control-popover" aria-label="音频详细设置">
                  <header><strong>音频设置</strong><span>输入与输出</span></header>
                  <label class="audio-range"><span>麦克风输入 <b>{{ Math.round(inputGain * 100) }}%</b></span><input type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="inputGain"
                    aria-label="麦克风输入音量" @input="updateInputGain(Number(($event.target as HTMLInputElement).value))" /></label>
                  <div class="audio-input-meter">
                    <span>输入等级 <b>{{ localInputLevelPercent }}%</b></span>
                    <div class="audio-level-segments" role="meter" aria-label="麦克风输入等级" aria-valuemin="0" aria-valuemax="100"
                      :aria-valuenow="localInputLevelPercent">
                      <i v-for="segment in INPUT_LEVEL_SEGMENTS" :key="segment"
                        :class="{ 'is-active': segment / INPUT_LEVEL_SEGMENTS <= localInputLevel }" />
                    </div>
                  </div>
                  <label class="audio-range"><span>LycanSync 输出 <b>{{ Math.round(outputVolume * 100) }}%</b></span><input type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="outputVolume"
                    aria-label="LycanSync 总输出音量" @input="updateOutputVolume(Number(($event.target as HTMLInputElement).value))" /></label>
                  <label class="audio-range"><span>共享声音 <b>{{ Math.round(screenShareVolume * 100) }}%</b></span><input type="range" min="0" :max="AUDIO_VOLUME_MAX" :step="AUDIO_VOLUME_STEP" :value="screenShareVolume"
                    aria-label="屏幕共享声音音量" @input="updateScreenShareVolume(Number(($event.target as HTMLInputElement).value))" /></label>
                  <small>成员麦克风音量与共享声音音量分开设置，均受 LycanSync 总输出音量控制。</small>
                  <div class="audio-options">
                    <label class="audio-option"><span>回声消除</span><input type="checkbox" :checked="audioProcessing.echoCancellation"
                      @change="updateAudioProcessing('echoCancellation', ($event.target as HTMLInputElement).checked)" /></label>
                    <label class="audio-option"><span>环境降噪</span><input type="checkbox" :checked="audioProcessing.noiseSuppression"
                      @change="updateAudioProcessing('noiseSuppression', ($event.target as HTMLInputElement).checked)" /></label>
                    <label class="audio-option"><span>自动增益</span><input type="checkbox" :checked="audioProcessing.autoGainControl"
                      @change="updateAudioProcessing('autoGainControl', ($event.target as HTMLInputElement).checked)" /></label>
                    <label class="audio-option"><span>人声增强</span><input type="checkbox" :checked="audioProcessing.voiceEnhancement"
                      @change="updateAudioProcessing('voiceEnhancement', ($event.target as HTMLInputElement).checked)" /></label>
                  </div>
                </section>
              </span>
              <IconButton :label="localParticipant?.isScreenShareEnabled ? '停止屏幕共享' : screenShareLimitReached ? '屏幕共享已达到 8 路上限' : '开始屏幕共享'"
                :class="{ 'is-active': localParticipant?.isScreenShareEnabled }"
                :disabled="!connected || screenShareLimitReached || rtc.busySources.includes(Track.Source.ScreenShare)"
                @click="rtc.toggleMedia(Track.Source.ScreenShare)"><MonitorUp :size="17" /></IconButton>
              <IconButton label="语音设置" tooltip="语音设置（即将开放）"
                @click="viewerNotice = '语音设置入口已预留，详细设置将在后续版本开放。'"><Settings :size="17" /></IconButton>
              <IconButton :label="joiningGroupId ? '取消连接' : '离开语音'" class="is-danger" :disabled="!joinedGroup && joiningGroupId === null" @click="leaveVoice"><LogOut :size="17" /></IconButton>
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
        <div v-for="member in orderedMembers" :key="member.userId" class="group-member-row"
          :class="{ 'is-offline': memberOnlineStatus(member) === 'OFFLINE' }"
          :data-tooltip="memberLastSeenTooltip(member)">
          <span class="group-member-avatar" :aria-label="memberStatusLabel(member)">
            <img v-if="member.userId === user.id ? user.avatar : member.avatar" :src="member.userId === user.id ? user.avatar : member.avatar" alt="" />
            <span v-else class="group-member-initial">{{ member.nickname.slice(0, 1) }}</span>
            <span v-if="memberOnlineStatus(member) !== 'OFFLINE'" class="status-dot" :class="memberOnlineStatus(member)" />
          </span>
          <span class="group-member-info">
            <span class="group-member-name">{{ member.userId === user.id ? user.nickname : member.nickname }}<small v-if="member.role === 'OWNER'" class="group-member-role">群主</small></span>
            <span v-if="memberActivity(member)" class="member-activity"><Gamepad2 :size="13" />{{ memberActivity(member) }}</span>
          </span>
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
        <p v-if="captureRequest.native && captureAudioAvailable">
          同时共享声音：{{ captureSourceType === 'window' ? '所选应用的声音' : '全系统声音（不含 LycanSync）' }}
        </p>
        <p v-else-if="captureRequest.native">当前系统仅支持共享画面。</p>
        <p v-else>浏览器共享不采集应用或系统声音。</p>
        <label v-if="captureRequest.native" class="capture-audio-option">
          <input v-model="captureShareAudio" type="checkbox" :disabled="!captureAudioAvailable" />
          同时共享声音（{{ captureSourceType === 'window' ? '该应用的声音' : '全系统声音，不含 LycanSync' }}）
        </label>
        <div class="capture-tabs" role="tablist" aria-label="共享来源类型">
          <button type="button" role="tab" :aria-selected="captureSourceType === 'window'"
            :disabled="!captureRequest.sources.some((source) => source.type === 'window')" @click="captureSourceType = 'window'">应用窗口</button>
          <button type="button" role="tab" :aria-selected="captureSourceType === 'screen'"
            :disabled="!captureRequest.sources.some((source) => source.type === 'screen')" @click="captureSourceType = 'screen'">整个屏幕</button>
        </div>
        <div class="capture-sources" role="tabpanel">
          <button v-for="source in captureSources" :key="source.id" :aria-label="source.name" @click="selectCaptureSource(source.id)">
            <img v-if="source.thumbnail" :src="source.thumbnail" alt="" />
            <span v-else class="capture-source-placeholder"><MonitorUp :size="32" /></span>
            <span>{{ source.name }}</span>
          </button>
        </div>
        <p v-if="!captureSources.length">没有可共享的{{ captureSourceType === 'window' ? '应用窗口' : '屏幕' }}，请切换来源类型后重试。</p>
        <div class="dialog-actions"><button autofocus @click="selectCaptureSource(null)">取消共享</button></div>
      </section>
    </div>
    <RemoteAudio v-for="item in remoteAudioTracks" :key="item.track.sid" :track="item.track"
      :volume="listening ? (item.source === Track.Source.ScreenShareAudio
        ? remoteScreenSharePlaybackVolume() : remotePlaybackVolume(item.participantIdentity)) : 0" />
    <GlobalTooltip />
  </div>
</template>
