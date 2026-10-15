<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, reactive, ref, watch } from 'vue';
import { AudioLines, ChevronDown, ChevronLeft, ChevronRight, Copy, CornerUpLeft, Gamepad2, Headphones,
  LogOut, Minus, Plus, RadioTower,
  Settings, Square, Volume2, X } from '@lucide/vue';
import { RemoteAudioTrack, Track, type Participant } from 'livekit-client';
import ParticipantCard from './components/ParticipantCard.vue';
import CallControls from './components/CallControls.vue';
import PersonalStatusCard from './components/PersonalStatusCard.vue';
import RemoteAudio from './components/RemoteAudio.vue';
import IconButton from './components/IconButton.vue';
import SettingsView from './components/SettingsView.vue';
import AppNotice from './components/AppNotice.vue';
import GroupEntryDialog from './components/GroupEntryDialog.vue';
import GroupMenu from './components/GroupMenu.vue';
import GroupManagementDialog from './components/GroupManagementDialog.vue';
import GroupChat from './components/GroupChat.vue';
import ScreenSharePicker from './components/ScreenSharePicker.vue';
import { createGroup, updateGroup, findGroup, findGroupPresences, findGroups, nextPresenceWaitRequest, waitForGroupPresenceChanges,
  type GroupDetail, type GroupMember, type GroupPresence, type GroupPresenceChangeCursor, type GroupSummary } from './group/groupApi';
import { useRtcRoom } from './rtc/useRtcRoom';
import { useMicrophoneTest } from './rtc/useMicrophoneTest';
import { readScreenShareQuality, saveScreenShareQuality, type ScreenShareQualityId } from './rtc/screenShareQuality';
import { canSelectNativeSource, readScreenShareAudioPreference, saveScreenShareAudioPreference,
  resolveNativeScreenAudioCapability, shouldShareAudioInNativeSelection,
  type NativeScreenAudioMode } from './rtc/nativeScreenAudioMode';
import { createNativeVideoSourceSelection } from './components/nativeVideoSourceSelection';
import { useRoomSummary } from './rtc/useRoomSummary';
import { requestRoomOccupancies } from './rtc/roomSummaryApi';
import { AUDIO_VOLUME_MAX } from './rtc/audioPreferences';
import { useAudioPreferences, type AudioVolumeChange } from './rtc/useAudioPreferences';
import { entranceSoundToFile, loadEntranceSound } from './rtc/entranceSound';
import { useCallSounds } from './rtc/useCallSounds';
import { normalizeVoiceLevel } from './rtc/voiceLevel';
import { sendPresenceHeartbeat, type UserActivity, type UserPresenceStatus } from './presence/presenceApi';
import { ApiRequestError, type AuthUser, type ProfileUpdate } from './auth/authApi';
import { settingsSectionForEntry, type SettingsSectionId } from './settings/settingsSections';
import { useActivityVisibility } from './settings/useActivityVisibility';
import { ScreenShareStage } from './rtc/screenShareStage';
import { useStagePreferences } from './settings/useStagePreferences';

const props = defineProps<{
  user: AuthUser;
  windowMaximized: boolean;
  saveProfile: (profile: ProfileUpdate) => Promise<AuthUser>;
  startupUpdateWarning?: string;
}>();
const emit = defineEmits<{ logout: []; dismissUpdateWarning: [] }>();

const STATUS_LABELS = { idle: '未加入语音', joining: '正在连接', connected: '语音已连接', reconnecting: '正在重连' };
const CALLBAR_EXIT_DURATION_MS = 180;
const GROUP_LIST_REFRESH_INTERVAL_MS = 30_000;
const ROOM_OCCUPANCY_REFRESH_INTERVAL_MS = 5_000;
const PRESENCE_HEARTBEAT_INTERVAL_MS = 20_000;
const PRESENCE_IDLE_TIMEOUT_MS = 5 * 60_000;
const PRESENCE_IDLE_CHECK_INTERVAL_MS = 2_000;
const ACTIVITY_CLOCK_INTERVAL_MS = 10_000;
const PRESENCE_STATUS_LABELS: Record<UserPresenceStatus, string> = {
  ONLINE: '在线',
  AWAY: '离开',
  OFFLINE: '离线',
};
const audioPreferences = useAudioPreferences(props.user.id);
const { inputGain, outputVolume, screenShareVolume } = audioPreferences;
const audioProcessing = audioPreferences.processing;
const callSounds = useCallSounds(outputVolume);
const desktop = window.lycanDesktop;
const captureRequest = ref<{ sources: ReturnType<typeof createNativeVideoSourceSelection>['options'] } | null>(null);
const captureSourceType = ref<'window' | 'screen'>('window');
const captureQuality = ref<ScreenShareQualityId>(readScreenShareQuality());
const selectedCaptureSourceId = ref('');
const captureSourceNotice = ref('');
const capturePicker = ref<InstanceType<typeof ScreenSharePicker> | null>(null);
const captureSourcesElement = computed(() => capturePicker.value?.sourcesElement);
let lastCaptureSourceType: 'window' | 'screen' = localStorage.getItem('lycansync.capture-source-type') === 'screen' ? 'screen' : 'window';
let lastNativeSelection: { discoveryId: string; sourceId: string } | undefined;
let currentNativeDiscoveryId = '';
const captureAudioCapabilityReady = ref(false);
const captureAudioCapabilityFailed = ref(false);
const captureAudioMode = ref<NativeScreenAudioMode>('unavailable');
const captureShareAudio = ref(false);
type NativeScreenSourceSelection = { sourceId: string; shareAudio: boolean; quality?: ScreenShareQualityId };
const NATIVE_SOURCE_REFRESH_INTERVAL_MS = 750;
let nativeSourceChooser: ReturnType<typeof createNativeVideoSourceSelection> | undefined;
let nativeSourceChooserGeneration = 0;
let nativeSourceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let nativeSourceRefresh: { promise: Promise<void> } | undefined;
let nativeThumbnailRefresh: Promise<void> | undefined;
const nativeSourceLoading = ref(false);
const nativeSourceError = ref('');
const captureSources = computed(() => captureRequest.value?.sources
  .filter((source) => source.type === captureSourceType.value) ?? []);
function stopNativeSourceRefresh() {
  // IPC 无法在页面侧取消；使本次选择失效，迟到结果不能改写下次打开的选择器。
  nativeSourceChooserGeneration++;
  if (nativeSourceRefreshTimer !== undefined) clearTimeout(nativeSourceRefreshTimer);
  nativeSourceRefreshTimer = undefined;
  nativeSourceLoading.value = false;
}

function updateNativeSourceOptions(generation: number, chooser: ReturnType<typeof createNativeVideoSourceSelection>) {
  if (generation !== nativeSourceChooserGeneration || !captureRequest.value) return;
  captureRequest.value = { ...captureRequest.value, sources: chooser.options };
}

async function loadNativeSourceThumbnails(
  generation: number,
  chooser: ReturnType<typeof createNativeVideoSourceSelection>,
) {
  if (!desktop || nativeThumbnailRefresh || document.hidden
      || generation !== nativeSourceChooserGeneration || nativeSourceChooser !== chooser) return;
  const container = captureSourcesElement.value;
  if (!container) return;
  const bounds = container.getBoundingClientRect();
  const visibleIds = new Set([...container.querySelectorAll<HTMLButtonElement>('[data-source-id]')]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    }).map((element) => element.dataset.sourceId!));
  const requested = chooser.sourcesNeedingThumbnails(Date.now(), visibleIds, selectedCaptureSourceId.value);
  if (!requested.length) return;
  const discoveryId = currentNativeDiscoveryId;
  const promise = desktop.getNativeVideoSourceThumbnails(requested).then((thumbnails) => {
    if (generation !== nativeSourceChooserGeneration || nativeSourceChooser !== chooser
        || currentNativeDiscoveryId !== discoveryId) return;
    chooser.applyThumbnails(requested, thumbnails);
    updateNativeSourceOptions(generation, chooser);
  }).catch((error) => {
    console.error('共享来源缩略图更新失败', error);
  });
  nativeThumbnailRefresh = promise;
  try { await promise; }
  finally { if (nativeThumbnailRefresh === promise) nativeThumbnailRefresh = undefined; }
}

async function refreshNativeSources(
  generation: number,
  chooser: ReturnType<typeof createNativeVideoSourceSelection>,
) {
  if (!desktop || document.hidden || generation !== nativeSourceChooserGeneration || nativeSourceRefresh) return;
  const promise = (async () => {
    try {
      const snapshot = await desktop.listNativeVideoSources();
      if (generation !== nativeSourceChooserGeneration || nativeSourceChooser !== chooser
          || !captureRequest.value) return;
      if (currentNativeDiscoveryId && currentNativeDiscoveryId !== snapshot.discoveryId) chooser.replaceSources([]);
      const options = chooser.replaceSources(snapshot.sources);
      const firstSnapshot = !currentNativeDiscoveryId;
      if (currentNativeDiscoveryId && currentNativeDiscoveryId !== snapshot.discoveryId) {
        // helper 重启后来源标识不再可信，不能按同名窗口恢复选中。
        selectedCaptureSourceId.value = '';
        captureSourceNotice.value = '共享来源已重新连接，请重新选择。';
      }
      currentNativeDiscoveryId = snapshot.discoveryId;
      if (firstSnapshot && lastNativeSelection?.discoveryId === snapshot.discoveryId
          && options.some((source) => source.id === lastNativeSelection?.sourceId && source.type === captureSourceType.value)) {
        selectedCaptureSourceId.value = lastNativeSelection.sourceId;
      }
      if (selectedCaptureSourceId.value && !options.some((source) => source.id === selectedCaptureSourceId.value)) {
        selectedCaptureSourceId.value = '';
        captureSourceNotice.value = '所选窗口或屏幕已不可用，请重新选择。';
      }
      captureRequest.value = { ...captureRequest.value!, sources: options };
      nativeSourceLoading.value = false;
      nativeSourceError.value = '';
      await nextTick();
      void loadNativeSourceThumbnails(generation, chooser);
    } catch (error) {
      if (generation !== nativeSourceChooserGeneration || nativeSourceChooser !== chooser
          || !captureRequest.value) return;
      nativeSourceLoading.value = false;
      if (!nativeSourceError.value) console.error('共享来源读取失败', error);
      nativeSourceError.value = '无法读取共享来源，正在重试。';
    }
  })();
  nativeSourceRefresh = { promise };
  try { await promise; }
  finally {
    if (nativeSourceRefresh?.promise === promise) nativeSourceRefresh = undefined;
  }
}

async function scheduleNativeSourceRefresh(generation: number, chooser: ReturnType<typeof createNativeVideoSourceSelection>) {
  await refreshNativeSources(generation, chooser);
  if (generation !== nativeSourceChooserGeneration || nativeSourceChooser !== chooser) return;
  // 等本次枚举完成再计时，慢请求不会按固定频率不断积压。
  nativeSourceRefreshTimer = setTimeout(() => void scheduleNativeSourceRefresh(generation, chooser),
    NATIVE_SOURCE_REFRESH_INTERVAL_MS);
}

function refreshVisibleSourceThumbnails() {
  if (nativeSourceChooser) void loadNativeSourceThumbnails(nativeSourceChooserGeneration, nativeSourceChooser);
}

function chooseCaptureSource(sourceId: string) {
  if (!captureSources.value.some((source) => source.id === sourceId)) return;
  selectedCaptureSourceId.value = sourceId;
  captureSourceNotice.value = '';
  refreshVisibleSourceThumbnails();
}

function selectCaptureSource(sourceId: string | null) {
  const request = captureRequest.value;
  if (!request) return;
  if (sourceId !== null
      && (!sourceId || nativeSourceError.value
        || !canSelectNativeSource(captureAudioCapabilityReady.value, captureAudioCapabilityFailed.value))) return;
  if (sourceId !== null && !request.sources.some((source) => source.id === sourceId)) return;
  if (sourceId) {
    lastCaptureSourceType = captureSourceType.value;
    lastNativeSelection = { discoveryId: currentNativeDiscoveryId, sourceId };
  }
  captureRequest.value = null;
  const chooser = nativeSourceChooser;
  nativeSourceChooser = undefined;
  stopNativeSourceRefresh();
  const selection = sourceId ? {
    sourceId,
    quality: captureQuality.value,
    shareAudio: shouldShareAudioInNativeSelection(
      captureAudioCapabilityReady.value,
      captureAudioMode.value,
      captureShareAudio.value,
    ),
  } : null;
  captureAudioCapabilityReady.value = false;
  captureAudioCapabilityFailed.value = false;
  // 取消及清理不依赖偏好存储；写入失败也必须结束本次选择等待。
  chooser?.finish(selection);
  if (selection) {
    saveCapturePreferences(captureQuality.value, lastCaptureSourceType);
    if (captureAudioMode.value !== 'unavailable') {
      try { saveScreenShareAudioPreference(captureAudioMode.value, selection.shareAudio); }
      catch { viewerNotice.value = '已确认本次共享选择，但无法保存本机音频偏好。'; }
    }
  }
}
function saveCapturePreferences(quality: ScreenShareQualityId, sourceType?: 'window' | 'screen') {
  try {
    saveScreenShareQuality(quality);
    if (sourceType) localStorage.setItem('lycansync.capture-source-type', sourceType);
  } catch {
    viewerNotice.value = '无法保存本机共享偏好，下次启动可能恢复原设置。';
  }
}
function updateCaptureShareAudio(enabled: boolean) {
  captureShareAudio.value = enabled;
}
function requestNativeScreenSource(
  capabilities: Promise<Record<string, { available: boolean; reason: string }>>,
): Promise<NativeScreenSourceSelection | null> {
  selectCaptureSource(null);
  const chooser = createNativeVideoSourceSelection([]);
  const generation = ++nativeSourceChooserGeneration;
  nativeSourceChooser = chooser;
  nativeSourceLoading.value = true;
  nativeSourceError.value = '';
  captureAudioCapabilityReady.value = false;
  captureAudioCapabilityFailed.value = false;
  captureAudioMode.value = 'unavailable';
  captureShareAudio.value = false;
  captureSourceType.value = lastCaptureSourceType;
  selectedCaptureSourceId.value = '';
  captureSourceNotice.value = '';
  currentNativeDiscoveryId = '';
  captureRequest.value = {
    sources: chooser.options,
  };
  void resolveNativeScreenAudioCapability(capabilities).then((state) => {
    if (generation !== nativeSourceChooserGeneration || nativeSourceChooser !== chooser) return;
    captureAudioMode.value = state.mode;
    try { captureShareAudio.value = readScreenShareAudioPreference(captureAudioMode.value); }
    catch {
      captureShareAudio.value = captureAudioMode.value === 'process';
      captureSourceNotice.value = '无法读取本机音频偏好，已使用默认设置。';
    }
    captureAudioCapabilityFailed.value = state.failed;
    captureAudioCapabilityReady.value = true;
  });
  void scheduleNativeSourceRefresh(generation, chooser);
  return chooser.result;
}

watch(captureSourceType, () => {
  if (!captureSources.value.some((source) => source.id === selectedCaptureSourceId.value)) selectedCaptureSourceId.value = '';
  void nextTick().then(refreshVisibleSourceThumbnails);
});
async function changeScreenShareQuality(quality: ScreenShareQualityId) {
  const applied = localParticipant.value?.isScreenShareEnabled ? await rtc.setScreenShareQuality(quality) : true;
  if (applied) {
    captureQuality.value = quality;
    saveCapturePreferences(quality);
  }
}
async function changeScreenShareAudio(enabled: boolean) {
  const mode = rtc.currentScreenShareAudioMode;
  if (!await rtc.setScreenShareAudioEnabled(enabled)) return;
  try { saveScreenShareAudioPreference(mode, enabled); }
  catch { viewerNotice.value = '本次音频设置已生效，但无法保存到本机。'; }
}
const rtc = reactive(useRtcRoom({
  screenShareQuality: captureQuality.value,
  inputGain: inputGain.value,
  processing: audioProcessing,
  events: {
    beforeMicrophoneChange: (): Promise<void> => microphoneTest.stop(),
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
const microphoneTest = reactive(useMicrophoneTest({
  preferences: audioPreferences,
  desktop,
  canStart: () => rtc.status !== 'joining' && rtc.status !== 'reconnecting'
    && !rtc.busySources.includes(Track.Source.Microphone),
  publishedTrack: () => {
    void rtc.revision;
    if (rtc.status !== 'connected' || !rtc.microphoneEnabled) return undefined;
    const publication = rtc.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    return publication && !publication.isMuted ? publication.track?.mediaStreamTrack : undefined;
  },
}));

// 预先恢复被静音成员的订阅策略；之后只有跨越 0% 时才更新网络订阅。
audioPreferences.mutedParticipantIdentities()
  .forEach((identity) => rtc.setRemoteAudioSubscribed(identity, false));
const removeCloseListener = desktop?.onClose(async () => {
  selectCaptureSource(null);
  await reportOfflineBeforeClose();
  try { await microphoneTest.stop(); }
  finally {
    try { await rtc.leave(); }
    finally { desktop.finishClose(); }
  }
});
onScopeDispose(() => {
  joinAttempt++;
  selectCaptureSource(null); removeCloseListener?.();
  closeGroupEditor(); groupActionRequest?.abort();
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
const editingGroup = ref<GroupDetail | null>(null);
const management = ref<{ group: GroupDetail; mode: 'invite' | 'members' | 'transfer' | 'leave' | 'dissolve' } | null>(null);
let detailRequest: AbortController | null = null;
let listRequest: AbortController | null = null;
let groupActionRequest: AbortController | null = null;
let groupEditorGeneration = 0;
let groupPresenceRequest: AbortController | null = null;
let groupPresenceWaitRequest: AbortController | null = null;
let groupPresenceWatchGeneration = 0;
let groupPresenceRetryTimer: ReturnType<typeof setTimeout> | null = null;
let cancelGroupPresenceRetry: (() => void) | null = null;
const presenceCursors = new Map<string, Pick<GroupPresenceChangeCursor, 'serverInstanceId' | 'version'>>();
const presenceConnectionLost = ref(false);
let roomOccupancyRequest: AbortController | null = null;
let joinAttempt = 0;
let presenceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let presenceIdleTimer: ReturnType<typeof setInterval> | null = null;
let activityClockTimer: ReturnType<typeof setInterval> | null = null;
let presenceAbort: AbortController | null = null;
let presenceStopped = false;
const currentPresenceStatus = ref<UserPresenceStatus>('ONLINE');
const currentActivity = ref<(UserActivity & { startedAt: string }) | null>(null);
const { showActivity, error: activityVisibilityError, setShowActivity } = useActivityVisibility(props.user.id);
const sharedActivity = computed(() => showActivity.value ? currentActivity.value : null);
const activityClock = ref(Date.now());
let activityRevision = 0;
const activitySnapshotRevision = activityRevision;
watch(showActivity, () => { void sendHeartbeat(); });

function applyDetectedActivity(activity: DetectedActivity | null) {
  if (presenceStopped) return;
  activityRevision++;
  if (JSON.stringify(activity) === JSON.stringify(currentActivity.value)) return;
  currentActivity.value = activity;
  void sendHeartbeat();
}
const removeActivityListener = desktop?.onActivityChange(applyDetectedActivity);
void desktop?.getCurrentActivity().then((activity) => {
  if (activityRevision === activitySnapshotRevision) applyDetectedActivity(activity);
}).catch(() => undefined);
onScopeDispose(() => removeActivityListener?.());

async function sendHeartbeat() {
  if (presenceStopped) return;
  presenceAbort?.abort();
  const controller = new AbortController();
  presenceAbort = controller;
  try {
    const activity = sharedActivity.value
      ? { type: sharedActivity.value.type, name: sharedActivity.value.name }
      : null;
    await sendPresenceHeartbeat(currentPresenceStatus.value, activity, controller.signal);
  } catch {
    // 心跳失败不阻塞 UI；下一次周期再试。
  }
}

function startPresenceHeartbeat() {
  if (presenceHeartbeatTimer) return;
  presenceStopped = false;
  void sendHeartbeat();
  presenceHeartbeatTimer = setInterval(() => void sendHeartbeat(), PRESENCE_HEARTBEAT_INTERVAL_MS);
}

function stopPresenceHeartbeat() {
  presenceStopped = true;
  presenceAbort?.abort();
  presenceAbort = null;
  if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);
  presenceHeartbeatTimer = null;
}

async function reportOfflineBeforeClose() {
  stopPresenceHeartbeat();
  await sendPresenceHeartbeat('OFFLINE', null, AbortSignal.timeout(1_200)).catch(() => undefined);
}

async function updateOwnPresenceStatus() {
  const systemIdle = await desktop?.getSystemIdleState().catch(() => null);
  // 系统查询失败时保留上次状态，下一轮重试，不能据此判定用户已经恢复操作。
  if (presenceStopped || (desktop && (!systemIdle || systemIdle.state === 'unknown'))) return;
  const nextStatus = systemIdle && (systemIdle.state === 'idle' || systemIdle.state === 'locked'
    || systemIdle.idleSeconds >= PRESENCE_IDLE_TIMEOUT_MS / 1000) ? 'AWAY' : 'ONLINE';
  if (nextStatus === currentPresenceStatus.value) return;
  currentPresenceStatus.value = nextStatus;
  void sendHeartbeat();
}

async function refreshGroupPresences(groupId: string, generation: number, signal: AbortSignal) {
  try {
    const result = await findGroupPresences(groupId, signal);
    if (!signal.aborted && generation === groupPresenceWatchGeneration && selectedGroupId.value === groupId) {
      groupPresences.value = Object.fromEntries(result.map((presence) => [presence.userId, presence]));
      const detail = selectedGroupDetail.value;
      const memberIds = new Set(result.map((presence) => presence.userId));
      if (detail?.id === groupId && (detail.members.length !== memberIds.size
          || detail.members.some((member) => !memberIds.has(member.userId)))) {
        // 状态快照也确认当前成员资格；名单变化时立即复核资料，不等待群列表周期刷新。
        void loadGroup(groupId, true);
      }
      presenceConnectionLost.value = false;
      return true;
    }
    return false;
  } catch {
    if (!signal.aborted && generation === groupPresenceWatchGeneration) presenceConnectionLost.value = true;
    return false;
  }
}

function waitForPresenceRetry(delayMs: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      if (groupPresenceRetryTimer) clearTimeout(groupPresenceRetryTimer);
      groupPresenceRetryTimer = null;
      cancelGroupPresenceRetry = null;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    cancelGroupPresenceRetry = finish;
    groupPresenceRetryTimer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function stopGroupPresenceSync() {
  groupPresenceWatchGeneration++;
  groupPresenceWaitRequest?.abort();
  groupPresenceWaitRequest = null;
  groupPresenceRequest?.abort();
  groupPresenceRequest = null;
  cancelGroupPresenceRetry?.();
}

function startGroupPresenceSync(groupId: string | null, refreshImmediately = false) {
  stopGroupPresenceSync();
  const generation = groupPresenceWatchGeneration;
  if (!groupId) {
    groupPresences.value = {};
    presenceConnectionLost.value = false;
    return;
  }

  const controller = new AbortController();
  groupPresenceWaitRequest = controller;
  void (async () => {
    let retryDelayMs = 1_000;
    let refreshSnapshot = refreshImmediately;
    while (!controller.signal.aborted && generation === groupPresenceWatchGeneration
        && selectedGroupId.value === groupId) {
      try {
        if (refreshSnapshot) {
          const snapshotController = new AbortController();
          groupPresenceRequest = snapshotController;
          const loaded = await refreshGroupPresences(groupId, generation, snapshotController.signal);
          if (controller.signal.aborted || generation !== groupPresenceWatchGeneration) return;
          if (!loaded) throw new Error('成员状态快照暂时不可用');
          refreshSnapshot = false;
        }

        const waiter = nextPresenceWaitRequest();
        const response = await waitForGroupPresenceChanges(groupId, waiter.clientId, waiter.requestId,
          presenceCursors.get(groupId) ?? null, controller.signal);
        if (controller.signal.aborted || generation !== groupPresenceWatchGeneration
            || selectedGroupId.value !== groupId) return;
        presenceCursors.set(groupId, { serverInstanceId: response.serverInstanceId, version: response.version });
        presenceConnectionLost.value = false;
        retryDelayMs = 1_000;
        if (response.changed) refreshSnapshot = true;
      } catch {
        if (controller.signal.aborted || generation !== groupPresenceWatchGeneration) return;
        presenceConnectionLost.value = true;
        refreshSnapshot = true;
        await waitForPresenceRetry(retryDelayMs, controller.signal);
        retryDelayMs = Math.min(retryDelayMs * 2, 15_000);
      }
    }
  })();
}

const roomOccupancies = ref<Record<string, number>>({});
async function refreshRoomOccupancies(force = false) {
  // 周期刷新复用在途请求；明确的离房/网络恢复才取消旧请求，避免慢网络下反复中止。
  if (roomOccupancyRequest && !roomOccupancyRequest.signal.aborted && !force) return;
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
  } finally {
    if (roomOccupancyRequest === request) roomOccupancyRequest = null;
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
      if (management.value?.group.id === groupId) management.value.group = detail;
    }
  } catch (error) {
    if (!request.signal.aborted) {
      if (selectedGroupId.value === groupId) {
        groupError.value = error instanceof Error ? error.message : '无法读取群组资料';
      }
      // 旧预览不覆盖当前提示；若它仍是通话群，失去成员资格仍须正常离房。
      if (error instanceof ApiRequestError && error.status === 404) {
        if (joinedGroupId.value === groupId || joiningGroupId.value === groupId) leaveVoice();
        if (selectedGroupDetail.value?.id === groupId) selectedGroupDetail.value = null;
        if (management.value?.group.id === groupId) management.value = null;
        void refreshGroups(false);
      }
    }
  } finally {
    if (!request.signal.aborted && selectedGroupId.value === groupId) groupLoading.value = false;
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
    if (joinedGroupId.value && !result.some((group) => group.id === joinedGroupId.value)) leaveVoice();
    if (joiningGroupId.value && !result.some((group) => group.id === joiningGroupId.value)) leaveVoice();
    if (management.value && !result.some((group) => group.id === management.value?.group.id)) management.value = null;
    if (editingGroup.value && !result.some((group) => group.id === editingGroup.value?.id)) closeGroupEditor();
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
      if (refreshDetail || !keepExisting || selectedGroupDetail.value?.memberCount !== selectedSummary?.memberCount
          || selectedGroupDetail.value?.updatedAt !== selectedSummary?.updatedAt || selectedGroupDetail.value?.role !== selectedSummary?.role) {
        void loadGroup(selectedGroupId.value, keepExisting);
      }
    } else selectedGroupDetail.value = null;
  } catch (error) {
    if (!request.signal.aborted) groupError.value = error instanceof Error ? error.message : '无法读取群组列表';
  }
}
let groupListRefreshTimer: ReturnType<typeof setInterval> | null = null;
let roomOccupancyRefreshTimer: ReturnType<typeof setInterval> | null = null;
let lastActivationRefreshAt = 0;
function refreshOnActivation() {
  if (document.visibilityState === 'hidden' || Date.now() - lastActivationRefreshAt < 500) return;
  lastActivationRefreshAt = Date.now();
  void updateOwnPresenceStatus();
  void sendHeartbeat();
  roomSummaryRefreshVersion.value++;
  void refreshGroups();
  if (selectedGroupId.value) startGroupPresenceSync(selectedGroupId.value, true);
}
function handleVisibilityChange() {
  refreshOnActivation();
}
onMounted(() => {
  void updateOwnPresenceStatus();
  refreshOnActivation();
  startPresenceHeartbeat();
  window.addEventListener('focus', refreshOnActivation);
  window.addEventListener('online', handlePresenceNetworkRestored);
  window.addEventListener('offline', handlePresenceNetworkLost);
  window.addEventListener('resize', remeasureViewerHeight);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  presenceIdleTimer = setInterval(() => void updateOwnPresenceStatus(), PRESENCE_IDLE_CHECK_INTERVAL_MS);
  activityClockTimer = setInterval(() => { activityClock.value = Date.now(); }, ACTIVITY_CLOCK_INTERVAL_MS);
  groupListRefreshTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void refreshGroups(false, false);
  }, GROUP_LIST_REFRESH_INTERVAL_MS);
  roomOccupancyRefreshTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') {
      if (groups.value.length > 0) void refreshRoomOccupancies();
    }
  }, ROOM_OCCUPANCY_REFRESH_INTERVAL_MS);
});
watch(selectedGroupId, (groupId) => {
  groupActionRequest?.abort();
  groupPresences.value = {};
  presenceConnectionLost.value = false;
  startGroupPresenceSync(groupId, Boolean(groupId));
});
function handlePresenceNetworkRestored() {
  void updateOwnPresenceStatus();
  void sendHeartbeat();
  roomSummaryRefreshVersion.value++;
  void refreshRoomOccupancies(true);
  if (selectedGroupId.value && document.visibilityState !== 'hidden') {
    startGroupPresenceSync(selectedGroupId.value, true);
  }
}
function handlePresenceNetworkLost() {
  presenceConnectionLost.value = true;
}
onScopeDispose(() => {
  window.removeEventListener('focus', refreshOnActivation);
  window.removeEventListener('online', handlePresenceNetworkRestored);
  window.removeEventListener('offline', handlePresenceNetworkLost);
  window.removeEventListener('resize', remeasureViewerHeight);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  stopGroupPresenceSync();
  roomOccupancyRequest?.abort();
  stopPresenceHeartbeat();
  if (presenceIdleTimer) clearInterval(presenceIdleTimer);
  if (activityClockTimer) clearInterval(activityClockTimer);
  if (groupListRefreshTimer) clearInterval(groupListRefreshTimer);
  if (roomOccupancyRefreshTimer) clearInterval(roomOccupancyRefreshTimer);
});

function openEditor() {
  groupActionRequest?.abort();
  groupEditorGeneration++;
  editingGroup.value = null;
  editorOpen.value = true;
}

function closeGroupEditor() {
  groupEditorGeneration++;
  editorOpen.value = false;
  editingGroup.value = null;
}

async function createGroupFromDialog(name: string, description: string, avatar: string) {
  const generation = groupEditorGeneration;
  const editing = editingGroup.value;
  const detail = editing ? await updateGroup(editing.id, name, description, avatar)
    : await createGroup(name, description, avatar);
  // 写入可能已在服务端完成；旧窗口只放弃更新界面，不能关闭新编辑窗口或再次请求群列表。
  if (!editorOpen.value || generation !== groupEditorGeneration) return;
  if (!editing) {
    await refreshGroups();
    if (!editorOpen.value || generation !== groupEditorGeneration) return;
  }
  applyGroupDetail(detail);
  if (!editing) {
    selectedGroupId.value = detail.id;
    selectedGroupDetail.value = detail;
  }
  closeGroupEditor();
}

function applyGroupDetail(detail: GroupDetail) {
  groups.value = groups.value.some((group) => group.id === detail.id)
    ? groups.value.map((group) => group.id === detail.id ? detail : group) : [...groups.value, detail];
  if (selectedGroupId.value === detail.id) selectedGroupDetail.value = detail;
  if (joinedGroupId.value === detail.id) joinedGroupDetail.value = detail;
  if (management.value?.group.id === detail.id) management.value.group = detail;
}

function joinedFromCode(detail: GroupDetail) {
  applyGroupDetail(detail);
  selectedGroupId.value = detail.id;
  selectedGroupDetail.value = detail;
  closeGroupEditor();
}

async function openGroupAction(action: 'edit' | 'invite' | 'members' | 'transfer' | 'leave' | 'dissolve') {
  const groupId = selectedGroupId.value;
  if (!groupId) return;
  groupActionRequest?.abort();
  const request = new AbortController();
  groupActionRequest = request;
  try {
    const detail = await findGroup(groupId, request.signal);
    if (request.signal.aborted || selectedGroupId.value !== groupId) return;
    applyGroupDetail(detail);
    if (action === 'edit') { groupEditorGeneration++; editingGroup.value = detail; editorOpen.value = true; }
    else management.value = { group: detail, mode: action };
  } catch (exception) {
    if (!request.signal.aborted && selectedGroupId.value === groupId) {
      groupError.value = exception instanceof Error ? exception.message : '无法读取群组，请重试。';
    }
  } finally {
    if (groupActionRequest === request) groupActionRequest = null;
  }
}

function removedFromGroup(groupId: string) {
  if (joinedGroupId.value === groupId || joiningGroupId.value === groupId) leaveVoice();
  management.value = null;
  groups.value = groups.value.filter((group) => group.id !== groupId);
  if (selectedGroupId.value === groupId) selectedGroupId.value = groups.value[0]?.id ?? null;
  selectedGroupDetail.value = null;
  void refreshGroups();
}
const joinedGroupId = ref<string | null>(null);
const locallyLeftVoiceGroupId = ref<string | null>(null);
const roomSummaryRefreshVersion = ref(0);
const joiningGroupId = ref<string | null>(null);
const pendingSwitchGroupId = ref<string | null>(null);
const listening = computed(() => rtc.listening);
const settingsOpen = ref(false);
const settingsSection = ref<SettingsSectionId>('audio');
const settingsReturnFocus = ref<HTMLElement | null>(null);
const stage = reactive(new ScreenShareStage());
const stagePreferences = useStagePreferences(props.user.id);
const enlargedIdentities = computed(() => stage.slots.filter((id): id is string => id !== null));
const stageDrag = ref<{ identity: string; room: typeof rtc.room } | null>(null);
const stageDropSlot = ref<number | null>(null);
const membersExpanded = ref(false);
const filmstripPage = ref(0);
const viewerGrid = ref<HTMLElement | null>(null);
const lockedViewerHeight = ref<number | null>(null);
const viewerNotice = ref('');
const departingGroupId = ref<string | null>(null);
const callbarLeaving = ref(false);
function releaseViewerLock() {
  lockedViewerHeight.value = null;
}
onScopeDispose(() => {
  releaseViewerLock();
});

async function openSettings(section: SettingsSectionId, event: Event | HTMLElement) {
  settingsReturnFocus.value = event instanceof HTMLElement ? event
    : event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  settingsSection.value = section;
  settingsOpen.value = true;
  await nextTick();
  document.querySelector<HTMLElement>('.settings-header h1')?.focus();
}

async function closeSettings() {
  try { await microphoneTest.stop(); }
  catch { viewerNotice.value = '麦克风试听停止未确认，请重启客户端后再试。'; }
  settingsOpen.value = false;
  await nextTick();
  settingsReturnFocus.value?.focus();
  settingsReturnFocus.value = null;
}

const selectedGroup = computed(() => groups.value.find((group) => group.id === selectedGroupId.value) ?? null);
const joinedGroup = computed(() => groups.value.find((group) => group.id === joinedGroupId.value) ?? null);
const callbarGroup = computed(() => joinedGroup.value
  ?? groups.value.find((group) => group.id === joiningGroupId.value)
  ?? groups.value.find((group) => group.id === departingGroupId.value)
  ?? null);
const pendingSwitchGroup = computed(() => groups.value.find((group) => group.id === pendingSwitchGroupId.value) ?? null);
const localParticipant = computed(() => rtc.room?.localParticipant);
const sharingAudio = computed(() => {
  void rtc.revision;
  return Boolean(localParticipant.value?.getTrackPublication(Track.Source.ScreenShareAudio)?.track);
});
const localMicrophoneLevel = computed(() => {
  void rtc.revision;
  const participant = localParticipant.value;
  return rtc.microphoneEnabled && participant?.isSpeaking ? participant.audioLevel : 0;
});
const localInputLevel = computed(() => {
  void rtc.revision;
  const participant = localParticipant.value;
  return rtc.microphoneEnabled && participant ? normalizeVoiceLevel(participant.audioLevel) : 0;
});
const localInputLevelPercent = computed(() => Math.round(localInputLevel.value * 100));
const connected = computed(() => rtc.status === 'connected');
const showingJoinedGroup = computed(() => joinedGroupId.value !== null && selectedGroupId.value === joinedGroupId.value);
const fetchedRoomSummary = useRoomSummary(selectedGroupId, computed(() => !showingJoinedGroup.value),
  (message) => { summaryError.value = message; }, roomSummaryRefreshVersion);
const roomSummary = computed(() => {
  const summary = fetchedRoomSummary.value;
  if (!summary || locallyLeftVoiceGroupId.value !== selectedGroupId.value) return summary;
  // 离房清理和服务端成员移除可能尚未完成，本机不能用旧快照重新显示自己在语音中。
  const participants = summary.participants.filter((participant) => participant.participantIdentity !== `user-${props.user.id}`);
  return { participantCount: participants.length, participants };
});
watch(fetchedRoomSummary, (summary) => {
  if (summary && locallyLeftVoiceGroupId.value === selectedGroupId.value
      && !summary.participants.some((participant) => participant.participantIdentity === `user-${props.user.id}`)) {
    locallyLeftVoiceGroupId.value = null;
  }
});
const groupHasVoiceActivity = (groupId: string) => {
  if (joinedGroupId.value === groupId) return true;
  if (selectedGroupId.value === groupId && roomSummary.value) return roomSummary.value.participantCount > 0;
  return (roomOccupancies.value[groupId] ?? 0) > 0;
};
const currentMembers = computed(() => joinedGroupDetail.value?.members ?? []);
const memberOnlineStatus = (member: GroupMember) => {
  if (member.userId === props.user.id) return currentPresenceStatus.value;
  return groupPresences.value[member.userId]?.status ?? 'OFFLINE';
};
const memberActivity = (member: GroupMember) => {
  const activity = member.userId === props.user.id
    ? sharedActivity.value
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
const participantAvatar = (identity: string) => identity === `user-${props.user.id}` ? props.user.avatar
  : currentMembers.value.find((member) => `user-${member.userId}` === identity)?.avatar ?? '';
const previewParticipantName = (identity: string, displayName: string) =>
  selectedGroupDetail.value?.members.find((member) => `user-${member.userId}` === identity)?.nickname ?? displayName;
const previewParticipantAvatar = (identity: string) =>
  selectedGroupDetail.value?.members.find((member) => `user-${member.userId}` === identity)?.avatar ?? '';
const groupParticipants = computed(() => showingJoinedGroup.value ? rtc.participants : []);
const sharingParticipants = computed(() => {
  void rtc.revision;
  return groupParticipants.value.filter((participant) => participant.isScreenShareEnabled);
});
const filmstripPageCount = computed(() => Math.ceil(groupParticipants.value.length / 5));
const filmstripParticipants = computed(() => groupParticipants.value.slice(filmstripPage.value * 5, (filmstripPage.value + 1) * 5));
const activeScreenShareCount = computed(() => {
  void rtc.revision;
  return rtc.participants.filter((participant) => participant.isScreenShareEnabled).length;
});
const remoteControlShare = (identity: string) => rtc.remoteControlShares[identity];
const remoteControlCanRequest = (identity: string) => remoteControlShare(identity)?.kind === 'monitor';
const remoteControlIsPending = (identity: string) => rtc.remoteControlPending?.identity === identity;
const remoteControlIsActive = (identity: string) => rtc.remoteControlActive?.identity === identity;
// TODO: 服务端按群组原子分配并回收共享名额，处理并发开启、断线及失败；前端限制仅作提示。
const screenShareLimitReached = computed(() => activeScreenShareCount.value >= 8 && !localParticipant.value?.isScreenShareEnabled);
const sharingIdentityKey = computed(() => {
  void rtc.revision;
  return rtc.participants.filter((participant) => participant.isScreenShareEnabled).map((participant) => participant.identity).join('|');
});
const enlargedParticipants = computed(() => enlargedIdentities.value
  .map((identity) => sharingParticipants.value.find((participant) => participant.identity === identity))
  .filter((participant) => participant !== undefined));
const hasStage = computed(() => enlargedParticipants.value.length > 0);
const focusedOnSelectedGroup = computed(() => hasStage.value && showingJoinedGroup.value
  && enlargedParticipants.value.some((participant) => participant.identity === stage.focused));
const displayedSlots = computed(() => {
  const slots = stage.slots.map((identity, index) => ({ index,
    participant: sharingParticipants.value.find((participant) => participant.identity === identity) }));
  if (focusedOnSelectedGroup.value) return slots.filter((slot) => slot.participant?.identity === stage.focused);
  const lastOccupied = stage.slots.reduce((last, identity, index) => identity !== null ? index : last, -1);
  const count = stageDrag.value || lastOccupied >= 2 ? 4 : lastOccupied + 1;
  return slots.slice(0, count);
});

watch(() => [rtc.status, sharingIdentityKey.value] as const, ([status, key]) => {
  // 重连期间轨道列表可能暂时为空，不能将它视为用户停止共享并清除手动安排。
  if (status === 'reconnecting') { endStageDrag(); return; }
  stage.sync(key ? key.split('|') : []);
  if (stageDrag.value && !stage.available.includes(stageDrag.value.identity)) endStageDrag();
}, { immediate: true });
watch(stagePreferences.autoFill, (enabled) => stage.setAutoFill(enabled), { immediate: true });
watch(() => rtc.room, () => { stage.reset(); stage.sync(sharingIdentityKey.value ? sharingIdentityKey.value.split('|') : []); endStageDrag(); });
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
  .flatMap((participant) => ([
    { participantIdentity: participant.identity, source: Track.Source.Microphone,
      track: participant.getTrackPublication(Track.Source.Microphone)?.track },
    { participantIdentity: participant.identity, source: Track.Source.ScreenShareAudio,
      track: participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track },
  ]))
  .filter((item): item is { participantIdentity: string; source: Track.Source; track: RemoteAudioTrack } =>
    item.track instanceof RemoteAudioTrack));
// 先直接静音现有播放轨道，不能等 Vue 更新音频组件后才停止本机收听。
watch([listening, remoteAudioTracks], ([enabled, tracks]) => {
  if (!enabled) tracks.forEach((item) => item.track.setVolume(0));
}, { flush: 'sync' });
async function joinGroup(groupId: string) {
  selectCaptureSource(null);
  releaseViewerLock();
  const attempt = ++joinAttempt;
  selectedGroupId.value = groupId;
  pendingSwitchGroupId.value = null;
  joiningGroupId.value = groupId;
  stage.reset();
  endStageDrag();
  membersExpanded.value = false;
  viewerNotice.value = '';
  callbarLeaving.value = false;
  departingGroupId.value = null;

  if (joinedGroupId.value !== null) {
    void callSounds.left();
    await rtc.leave();
    if (attempt !== joinAttempt) return;
    joinedGroupId.value = null;
  }

  if (attempt !== joinAttempt) return;
  try {
    const detail = selectedGroupDetail.value?.id === groupId
      ? selectedGroupDetail.value : await findGroup(groupId);
    if (attempt !== joinAttempt) return;
    joinedGroupDetail.value = detail;
  } catch (error) {
    if (attempt !== joinAttempt) return;
    viewerNotice.value = error instanceof Error ? error.message : '无法读取群组成员';
    joiningGroupId.value = null;
    return;
  }
  if (attempt !== joinAttempt) return;

  const joined = await rtc.join(groupId);
  if (attempt !== joinAttempt) return;
  if (joined) {
    joinedGroupId.value = groupId;
    if (locallyLeftVoiceGroupId.value === groupId) locallyLeftVoiceGroupId.value = null;
    void callSounds.joined();
    const entranceSound = loadEntranceSound(props.user.id);
    if (entranceSound) {
      try { void rtc.sendEntranceSound(entranceSoundToFile(entranceSound)); }
      catch { viewerNotice.value = '本机保存的入场音效已损坏，请在“音效”设置中重新选择。'; }
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
  stage.focused = null;
  endStageDrag();
  membersExpanded.value = false;
  if (joinedGroupId.value !== null) {
    pendingSwitchGroupId.value = groupId;
    return;
  }
  void joinGroup(groupId);
}

function leaveVoice() {
  selectCaptureSource(null);
  releaseViewerLock();
  const attempt = ++joinAttempt;
  const leavingGroupId = joinedGroupId.value ?? joiningGroupId.value;
  if (leavingGroupId !== null) {
    locallyLeftVoiceGroupId.value = leavingGroupId;
    roomOccupancyRequest?.abort();
    if (joinedGroupId.value !== null) {
      roomOccupancies.value = { ...roomOccupancies.value, [leavingGroupId]: rtc.participants
        .filter((participant) => participant.identity !== `user-${props.user.id}`).length };
    }
    // 本机先更新离房意愿，真实断开等待资源清理；底栏只保留退场动画快照。
    departingGroupId.value = leavingGroupId;
    callbarLeaving.value = true;
  }
  if (rtc.status === 'connected' || rtc.status === 'reconnecting') void callSounds.left();
  void rtc.leave().then(() => {
    if (presenceStopped || attempt !== joinAttempt) return;
    roomSummaryRefreshVersion.value++;
    void refreshRoomOccupancies(true);
  }).catch(() => {
    if (!presenceStopped && attempt === joinAttempt && joinedGroupId.value === null && joiningGroupId.value === null) {
      viewerNotice.value = '离开语音未能确认，请重启客户端后再试。';
    }
  });
  joinedGroupId.value = null;
  joinedGroupDetail.value = null;
  joiningGroupId.value = null;
  pendingSwitchGroupId.value = null;
  stage.reset();
  endStageDrag();
  membersExpanded.value = false;
  viewerNotice.value = '';
  void refreshGroups(true, false);
}

async function toggleMicrophone() {
  if (!connected.value || !localParticipant.value) return;
  await rtc.toggleMedia(Track.Source.Microphone);
}

async function toggleListening() {
  if (!connected.value) return;
  const enabled = !listening.value;
  const changing = rtc.updateListeningState(enabled);
  if (rtc.needsAudioPlayback && enabled) {
    await rtc.enableAudioPlayback();
  }
  await changing;
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
function remotePlaybackVolume(identity: string) {
  return Math.min(AUDIO_VOLUME_MAX, participantVolume(identity) * outputVolume.value);
}
function remoteScreenSharePlaybackVolume() {
  return Math.min(AUDIO_VOLUME_MAX, screenShareVolume.value * outputVolume.value);
}

function toggleEnlargedParticipant(identity: string) {
  viewerNotice.value = '';
  if (stage.slots.includes(identity)) stage.remove(identity);
  else stage.place(identity);
  releaseViewerLock();
  if (!enlargedIdentities.value.length) membersExpanded.value = false;
}

function toggleFocusedParticipant(identity: string) {
  releaseViewerLock();
  if (stage.focused !== identity) membersExpanded.value = false;
  stage.toggleFocus(identity);
}

function beginStageDrag(identity: string, event: DragEvent) {
  if (focusedOnSelectedGroup.value || remoteControlIsActive(identity) || !event.dataTransfer) { event.preventDefault(); return; }
  stageDrag.value = { identity, room: rtc.room };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-lycansync-stage', identity);
  releaseViewerLock();
}

function endStageDrag() {
  stageDrag.value = null;
  stageDropSlot.value = null;
}

function moveStageParticipant(identity: string, target: number) {
  if (!showingJoinedGroup.value || focusedOnSelectedGroup.value || remoteControlIsActive(identity)
      || (stage.slots[target] && remoteControlIsActive(stage.slots[target]!))) return;
  stage.move(identity, target);
  releaseViewerLock();
}

function moveStageFromKeyboard(identity: string, index: number, offset: number) {
  if ((offset === -1 && index % 2 === 0) || (offset === 1 && index % 2 === 1)) return;
  moveStageParticipant(identity, index + offset);
}

function dragOverStage(slot: number, event: DragEvent) {
  if (!stageDrag.value || stageDrag.value.room !== rtc.room || !showingJoinedGroup.value || focusedOnSelectedGroup.value) return;
  if (stage.slots[slot] && remoteControlIsActive(stage.slots[slot]!)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  stageDropSlot.value = slot;
}

function dropOnStage(slot: number, event: DragEvent) {
  const drag = stageDrag.value;
  if (drag && drag.room === rtc.room && event.dataTransfer?.getData('application/x-lycansync-stage') === drag.identity) {
    event.preventDefault();
    moveStageParticipant(drag.identity, slot);
  }
  endStageDrag();
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
    stage.focused = null;
    endStageDrag();
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
    <AppNotice v-if="rtc.notice || viewerNotice" :message="rtc.notice || viewerNotice" />
    <AppNotice v-else-if="startupUpdateWarning" :message="startupUpdateWarning" dismissible @dismiss="emit('dismissUpdateWarning')" />
    <section v-if="rtc.remoteControlRequest" class="remote-control-prompt" role="dialog" aria-modal="true" aria-label="远程控制申请">
      <strong>{{ previewParticipantName(rtc.remoteControlRequest.identity,
        rtc.participants.find((participant) => participant.identity === rtc.remoteControlRequest?.identity)?.name || rtc.remoteControlRequest.identity) }}申请控制你的显示器</strong>
      <span>允许后，对方可以使用鼠标和常用键盘按键。你仍可随时停止控制。</span>
      <div><button type="button" :disabled="rtc.remoteControlGranting" @click="rtc.rejectRemoteControl">拒绝</button>
        <button type="button" class="confirm-button" :disabled="rtc.remoteControlGranting" @click="rtc.allowRemoteControl">允许</button></div>
    </section>
    <div v-if="rtc.remoteControlOwner" class="remote-control-owner-status" role="status">
      正在由 {{ previewParticipantName(rtc.remoteControlOwner.identity,
        rtc.participants.find((participant) => participant.identity === rtc.remoteControlOwner?.identity)?.name || rtc.remoteControlOwner.identity) }} 控制
      <button type="button" @click="rtc.revokeRemoteControl">停止控制</button>
    </div>
    <div v-else-if="rtc.remoteControlCleanupPending" class="remote-control-owner-status" role="alert">
      远程输入尚未释放
      <button type="button" @click="rtc.retryRemoteControlCleanup">重试撤销</button>
    </div>
    <div class="app-content" v-show="!settingsOpen" :inert="settingsOpen">
    <div class="workspace" :inert="editorOpen || !!management">
      <nav class="group-rail" aria-label="群组">
        <button v-for="group in groups" :key="group.id" type="button" class="group-button"
          :class="{ 'is-selected': selectedGroupId === group.id, 'is-in-call': joinedGroupId === group.id }"
          :aria-label="`${group.name}${groupHasVoiceActivity(group.id) ? '，当前有语音成员' : ''}，单击预览，双击加入语音`" :aria-pressed="selectedGroupId === group.id"
          :title="group.name"
          @click="previewGroup(group.id)" @dblclick="requestJoin(group.id)" @keydown.enter.prevent="requestJoin(group.id)">
          <img v-if="group.avatar" :src="group.avatar" class="group-rail-avatar" alt="" />
          <span v-else>{{ group.name.slice(0, 1) }}</span>
          <span v-if="groupHasVoiceActivity(group.id)" class="group-call-badge" aria-hidden="true"><Volume2 :size="12" :stroke-width="2.6" /></span>
        </button>
        <div class="rail-spacer" />
        <button class="group-button add-group" type="button" aria-label="创建群组" @click="openEditor"><Plus :size="17" /></button>
      </nav>
      <main v-if="selectedGroup" class="group-main">
        <header class="group-header">
          <div class="group-copy">
            <div class="group-title-row"><GroupMenu :key="selectedGroup.id" :group="selectedGroup" @select="openGroupAction" /></div>
            <p v-if="selectedGroup.description">{{ selectedGroup.description }}</p>
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
              <button v-if="focusedOnSelectedGroup" type="button" class="viewer-return" @click="stage.focused = null; releaseViewerLock()">返回多人舞台</button>
              <small data-testid="member-count">{{ groupParticipants.length }} 人 · {{ sharingParticipants.length }} / 8 路共享</small>
            </span>
          </div>
          <div v-if="hasStage" ref="viewerGrid" class="viewer-grid" :class="`viewer-count-${displayedSlots.length}`"
            :style="lockedViewerHeight === null ? undefined : { flex: `0 0 ${lockedViewerHeight}px` }">
            <div v-for="{ participant, index } in displayedSlots" :key="index" class="stage-slot"
              :class="{ 'is-drop-target': stageDropSlot === index }" :data-stage-slot="index"
              @dragover="dragOverStage(index, $event)" @dragleave="stageDropSlot === index && (stageDropSlot = null)"
              @drop="dropOnStage(index, $event)">
            <ParticipantCard v-if="participant" :key="participant.identity" :participant="participant"
              :revision="rtc.revision" :avatar="participantAvatar(participant.identity)" :is-local="participant === localParticipant" :is-listening="participantListening(participant)" :local-microphone-enabled="rtc.microphoneEnabled"
              :playback-volume="participantVolume(participant.identity)" :input-gain="inputGain" :output-volume="outputVolume"
              variant="viewer"
              :focused="focusedOnSelectedGroup" :stage-draggable="!focusedOnSelectedGroup && !remoteControlIsActive(participant.identity)"
              @remove="toggleEnlargedParticipant(participant.identity)"
              @drag-start="beginStageDrag(participant.identity, $event)" @drag-end="endStageDrag"
              @move="moveStageFromKeyboard(participant.identity, index, $event)"
              :remote-control-available="remoteControlCanRequest(participant.identity)"
              :remote-control-unavailable="remoteControlShare(participant.identity)?.kind === 'window'"
              :remote-control-pending="remoteControlIsPending(participant.identity)"
              :remote-control-active="remoteControlIsActive(participant.identity)"
              :remote-control-name="previewParticipantName(participant.identity, participant.name || participant.identity)"
              @focus="toggleFocusedParticipant(participant.identity)" @notice="viewerNotice = $event"
              @request-control="rtc.requestRemoteControl(participant.identity)" @cancel-control="rtc.cancelPendingRemoteControl(participant.identity)" @stop-control="rtc.exitRemoteControl"
              @remote-input="rtc.sendRemoteControlInput"
              @toggle-audio="toggleParticipantAudio(participant.identity)" @volume-change="updateParticipantVolume(participant.identity, $event)"
              @input-gain-change="updateInputGain" @output-volume-change="updateOutputVolume"
              @toggle-microphone="toggleMicrophone" @toggle-listening="toggleListening" />
              <div v-else class="stage-empty">{{ stageDrag ? '拖到这里放置画面' : '空闲位置' }}</div>
            </div>
          </div>
          <div v-else class="participant-grid">
            <ParticipantCard v-for="participant in groupParticipants" :key="participant.identity" :participant="participant"
              :revision="rtc.revision" :avatar="participantAvatar(participant.identity)" :is-local="participant === localParticipant" :is-listening="participantListening(participant)" :local-microphone-enabled="rtc.microphoneEnabled"
              :remote-control-available="remoteControlCanRequest(participant.identity)"
              :remote-control-unavailable="remoteControlShare(participant.identity)?.kind === 'window'"
              :remote-control-pending="remoteControlIsPending(participant.identity)"
              :remote-control-active="remoteControlIsActive(participant.identity)"
              :remote-control-name="previewParticipantName(participant.identity, participant.name || participant.identity)"
              :playback-volume="participantVolume(participant.identity)" :input-gain="inputGain" :output-volume="outputVolume"
              @select="toggleEnlargedParticipant(participant.identity)"
              @request-control="rtc.requestRemoteControl(participant.identity)" @cancel-control="rtc.cancelPendingRemoteControl(participant.identity)" @stop-control="rtc.exitRemoteControl"
              @remote-input="rtc.sendRemoteControlInput"
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
          <div v-if="hasStage && membersExpanded && !focusedOnSelectedGroup" class="filmstrip-row">
            <button v-if="filmstripPageCount > 1" type="button" class="filmstrip-page-button" aria-label="上一页成员"
              :disabled="filmstripPage === 0" @click="filmstripPage--"><ChevronLeft :size="17" /></button>
            <div class="member-filmstrip" data-testid="member-filmstrip">
              <ParticipantCard v-for="participant in filmstripParticipants" :key="participant.identity" :participant="participant"
                :revision="rtc.revision" :avatar="participantAvatar(participant.identity)" :is-local="participant === localParticipant" :is-listening="participantListening(participant)" :local-microphone-enabled="rtc.microphoneEnabled"
                :playback-volume="participantVolume(participant.identity)" :input-gain="inputGain" :output-volume="outputVolume"
                variant="thumbnail" :selected="enlargedIdentities.includes(participant.identity)"
                @select="toggleEnlargedParticipant(participant.identity)" @toggle-audio="toggleParticipantAudio(participant.identity)"
                @volume-change="updateParticipantVolume(participant.identity, $event)" @toggle-microphone="toggleMicrophone"
                @input-gain-change="updateInputGain" @output-volume-change="updateOutputVolume" @toggle-listening="toggleListening" />
            </div>
            <button v-if="filmstripPageCount > 1" type="button" class="filmstrip-page-button" aria-label="下一页成员"
              :disabled="filmstripPage >= filmstripPageCount - 1" @click="filmstripPage++"><ChevronRight :size="17" /></button>
          </div>
        </section>
        <GroupChat v-show="!focusedOnSelectedGroup" :key="selectedGroup.id" :group="selectedGroup"
          :members="selectedGroupDetail?.members ?? []" :user="user" />
        <Transition enter-active-class="callbar-enter-active">
          <div v-if="callbarGroup || joiningGroupId" class="callbar-reveal" :class="{ 'is-leaving': callbarLeaving }" data-testid="callbar">
            <div class="callbar-content">
              <footer class="callbar">
                <div class="call-state" role="status">
                  <RadioTower v-if="connected || rtc.status === 'reconnecting'" :size="17" /><Headphones v-else :size="17" />
                  <span><strong>{{ callbarLeaving ? '正在退出' : STATUS_LABELS[rtc.status] }}</strong>
                    <small>{{ callbarGroup?.name }}{{ joinedGroup && selectedGroupId !== joinedGroup.id && selectedGroup ? ' · 正在浏览 ' + selectedGroup.name : joiningGroupId ? ' · 加入中' : '' }}</small>
                  </span>
                </div>
                <IconButton v-if="joinedGroup && selectedGroupId !== joinedGroup.id" label="返回当前通话群组" @click="previewGroup(joinedGroup.id)"><CornerUpLeft :size="17" /></IconButton>
                <CallControls :connected="connected" :desktop="Boolean(desktop)"
                  :microphone-enabled="rtc.microphoneEnabled" :microphone-intent="rtc.microphoneIntent" :microphone-busy="rtc.busySources.includes(Track.Source.Microphone)"
                  :microphone-level="localMicrophoneLevel" :input-level-percent="localInputLevelPercent"
                  :listening="listening" :input-gain="inputGain" :output-volume="outputVolume"
                  :sharing="Boolean(localParticipant?.isScreenShareEnabled)" :share-limit-reached="screenShareLimitReached" :choosing-source="Boolean(captureRequest)"
                  :share-busy="rtc.busySources.includes(Track.Source.ScreenShare) || rtc.screenShareQualityBusy || rtc.screenShareSourceBusy"
                  :quality="localParticipant?.isScreenShareEnabled ? rtc.currentScreenShareQuality : captureQuality"
                  :share-audio="sharingAudio" :audio-mode="rtc.currentScreenShareAudioMode"
                  @microphone="toggleMicrophone" @listening="toggleListening"
                  @share="captureRequest ? selectCaptureSource(null) : rtc.toggleMedia(Track.Source.ScreenShare)"
                  @change-source="rtc.changeScreenShareSource" @quality="changeScreenShareQuality" @share-audio="changeScreenShareAudio"
                  @input-gain="updateInputGain" @output-volume="updateOutputVolume" @settings="openSettings('audio', $event)" />
                <IconButton :label="joiningGroupId ? '取消连接' : '离开语音'" class="is-danger"
                  :disabled="callbarLeaving || (!joinedGroup && joiningGroupId === null)" @click="leaveVoice"><LogOut :size="17" /></IconButton>
              </footer>
            </div>
          </div>
        </Transition>
      </main>
      <main v-else class="group-main group-empty">
        <p v-if="groupError" role="alert">{{ groupError }}</p>
        <p v-else>还没有群组，点击左侧的 + 创建一个开黑小队。</p>
      </main>
      <aside class="members-panel" aria-label="群组成员">
        <div class="members-list">
          <div class="members-header"><strong>成员<span v-if="selectedGroupDetail"> · {{ selectedGroupDetail.memberCount }}</span></strong>
          </div>
          <p v-if="presenceConnectionLost" class="group-hint" role="status">成员状态同步中断，当前显示可能已过期。</p>
          <p v-if="groupError" role="alert" class="group-error">{{ groupError }}</p>
          <p v-else-if="groupLoading" class="group-hint">正在读取成员…</p>
          <div v-for="member in orderedMembers" :key="member.userId" class="group-member-row"
            :class="{ 'is-offline': memberOnlineStatus(member) === 'OFFLINE' }">
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
        </div>
        <PersonalStatusCard :user="user" :status="currentPresenceStatus" :status-label="PRESENCE_STATUS_LABELS[currentPresenceStatus]">
          <IconButton label="语音与音频设置" @click="openSettings(settingsSectionForEntry('gear'), $event)"><Settings :size="19" /></IconButton>
        </PersonalStatusCard>
      </aside>
    </div>
    <GroupEntryDialog v-if="editorOpen" :group="editingGroup ?? undefined" :create-group="createGroupFromDialog"
      @joined="joinedFromCode" @close="closeGroupEditor" />
    <GroupManagementDialog v-if="management" :group="management.group" :mode="management.mode" :user-id="user.id"
      @updated="applyGroupDetail" @removed="removedFromGroup" @close="management = null" />
    </div>
    <SettingsView v-if="settingsOpen" :section="settingsSection" :user="user" :desktop="Boolean(desktop)"
      :presence-status="currentPresenceStatus" :presence-label="PRESENCE_STATUS_LABELS[currentPresenceStatus]"
      :preferences="audioPreferences" :rtc="rtc" :microphone-test="microphoneTest" :input-level-percent="localInputLevelPercent"
      :activity="currentActivity" :show-activity="showActivity" :activity-error="activityVisibilityError"
      :stage-auto-fill="stagePreferences.autoFill.value" :stage-preference-error="stagePreferences.error.value"
      @stage-auto-fill="stagePreferences.setAutoFill"
      @activity-visibility="setShowActivity"
      :save-profile="saveProfile" @close="closeSettings" @logout="emit('logout')" />
    <ScreenSharePicker v-if="captureRequest" ref="capturePicker" :sources="captureRequest.sources"
      v-model:source-type="captureSourceType" v-model:quality="captureQuality" :share-audio="captureShareAudio"
      @update:share-audio="updateCaptureShareAudio"
      :selected-id="selectedCaptureSourceId" :audio-mode="captureAudioMode" :audio-ready="captureAudioCapabilityReady"
      :audio-failed="captureAudioCapabilityFailed" :loading="nativeSourceLoading" :error="nativeSourceError" :notice="captureSourceNotice"
      @choose="chooseCaptureSource" @refresh-thumbnails="refreshVisibleSourceThumbnails"
      @close="selectCaptureSource(null)" @confirm="selectCaptureSource(selectedCaptureSourceId)" />
    <RemoteAudio v-for="item in remoteAudioTracks" :key="item.track.sid" :track="item.track"
      :volume="listening ? (item.source === Track.Source.ScreenShareAudio
        ? remoteScreenSharePlaybackVolume() : remotePlaybackVolume(item.participantIdentity)) : 0" />
  </div>
</template>
