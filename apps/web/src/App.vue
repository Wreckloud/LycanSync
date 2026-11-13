<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, provide, reactive, ref, watch } from 'vue';
import { ACCOUNT_CACHE, clearOtherAccountContentCaches, createAccountCache } from './cache/localCache';
import { useNotice } from './feedback/useNotice';
import { useInitialLoading } from './profile/useInitialLoading';
import { ArrowLeft, AudioLines, Copy, CornerUpLeft, Headphones,
  LoaderCircle, LogOut, Minus, Plus, RadioTower,
  Settings, Square, UserRound, Volume2, X } from '@lucide/vue';
import { RemoteAudioTrack, Track, type Participant } from 'livekit-client';
import ParticipantCard from './components/ParticipantCard.vue';
import CallControls from './components/CallControls.vue';
import PersonalStatusCard from './components/PersonalStatusCard.vue';
import RemoteAudio from './components/RemoteAudio.vue';
import IconButton from './components/IconButton.vue';
import SettingsView from './components/SettingsView.vue';
import AppNotice from './components/AppNotice.vue';
import GroupEntryDialog from './components/GroupEntryDialog.vue';
import DialogTransition from './components/DialogTransition.vue';
import GroupMenu from './components/GroupMenu.vue';
import GroupManagementDialog from './components/GroupManagementDialog.vue';
import GroupChat from './components/GroupChat.vue';
import ScreenSharePicker from './components/ScreenSharePicker.vue';
import { useInlineViewingMotion } from './viewing/useInlineViewingMotion';
import { observeWindowLayoutRestore } from './viewing/windowLayoutRestore';
import { createGroup, updateGroup, findGroup, findGroups,
  type GroupDetail, type GroupMember, type GroupSummary } from './group/groupApi';
import { useRtcRoom } from './rtc/useRtcRoom';
import { useMicrophoneTest } from './rtc/useMicrophoneTest';
import { useMicrophoneDevices } from './rtc/useMicrophoneDevices';
import { useAudioOutput } from './rtc/useAudioOutput';
import { useRecording } from './recording/useRecording';
import type { ScreenShareQualityId } from './rtc/screenShareQuality';
import { saveScreenShareAudioPreference } from './rtc/nativeScreenAudioMode';
import { useScreenShareSelection } from './rtc/useScreenShareSelection';
import { useRoomSummary } from './rtc/useRoomSummary';
import { requestRoomOccupancies } from './rtc/roomSummaryApi';
import { AUDIO_VOLUME_MAX } from './rtc/audioPreferences';
import { useAudioPreferences, type AudioVolumeChange } from './rtc/useAudioPreferences';
import { entranceSoundToFile, loadEntranceSound } from './rtc/entranceSound';
import { useCallSounds } from './rtc/useCallSounds';
import { normalizeVoiceLevel } from './rtc/voiceLevel';
import { useGroupPresences } from './group/useGroupPresences';
import { useOwnPresence } from './presence/useOwnPresence';
import { PRESENCE_STATUS_LABELS } from './presence/presenceApi';
import { ApiRequestError, type AuthUser, type ProfileUpdate } from './auth/authApi';
import type { SettingsSectionId } from './settings/settingsSections';
import { usePresenceVisibility } from './settings/usePresenceVisibility';
import { useActivityMappings } from './settings/useActivityMappings';
import { useAudioShortcuts, type VoiceMode } from './settings/useAudioShortcuts';
import { useCallSoundPreferences } from './settings/useCallSoundPreferences';
import ScreenShareWindows from './components/ScreenShareWindows.vue';
import RemoteControlRequest from './components/RemoteControlRequest.vue';
import GroupMembersPanel from './components/GroupMembersPanel.vue';
import { useDiagnosticReport } from './diagnostics/useDiagnosticReport';
import { useVoiceOverlay } from './overlay/useVoiceOverlay';

const props = defineProps<{
  user: AuthUser;
  windowMaximized: boolean;
  saveProfile: (profile: ProfileUpdate) => Promise<AuthUser>;
  startupUpdateWarning?: string;
  interactionBlocked?: boolean;
}>();
const emit = defineEmits<{ logout: []; dismissUpdateWarning: []; ready: [] }>();
const accountCache = createAccountCache(props.user.id);
const cacheCleanup = new AbortController();
void clearOtherAccountContentCaches(props.user.id, cacheCleanup.signal).catch(() => {
  if (!cacheCleanup.signal.aborted) console.warn('previous account content cache cleanup failed');
});
onScopeDispose(() => { accountCache.dispose(); cacheCleanup.abort(); });
provide(ACCOUNT_CACHE, accountCache);

const STATUS_LABELS = { idle: '未加入语音', joining: '正在连接语音', connected: '语音已连接', reconnecting: '正在重连' };
const CALLBAR_EXIT_DURATION_MS = 180;
const GROUP_LIST_REFRESH_INTERVAL_MS = 30_000;
const ROOM_OCCUPANCY_REFRESH_INTERVAL_MS = 5_000;
const audioPreferences = useAudioPreferences(props.user.id);
const { inputGain, outputVolume, screenShareVolume, voiceVolumeBalance } = audioPreferences;
const audioProcessing = audioPreferences.processing;
const callSoundPreferences = useCallSoundPreferences(props.user.id);
const desktop = window.lycanDesktop;
const audioOutput = useAudioOutput(audioPreferences, navigator.mediaDevices, desktop);
const callSounds = useCallSounds(outputVolume, callSoundPreferences, audioOutput);
const { notice: viewerNotice, noticeEvent: viewerNoticeEvent } = useNotice();
const mainWindowVisible = ref(true);
const windowLayout = observeWindowLayoutRestore(window);
watch(mainWindowVisible, visible => visible ? windowLayout.restore() : windowLayout.suspend(), { flush: 'sync' });
onScopeDispose(windowLayout.stop);
let appDisposed = false;
let nativeVisibilityReceived = false;
const removeVisibilityListener = desktop?.onWindowVisibility((visible) => {
  nativeVisibilityReceived = true;
  mainWindowVisible.value = visible;
});
void desktop?.getWindowVisibility().then((visible) => {
  if (!appDisposed && !nativeVisibilityReceived) mainWindowVisible.value = visible;
}).catch(() => { if (!appDisposed) viewerNotice.value = '无法确认主窗口显示状态，请重启客户端。'; });
onScopeDispose(() => { appDisposed = true; removeVisibilityListener?.(); });
const capturePicker = ref<InstanceType<typeof ScreenSharePicker> | null>(null);
let requestedGame: DetectedActivity | null = null;
const captureSelection = useScreenShareSelection({
  desktop, sourcesElement: () => capturePicker.value?.sourcesElement, notice: viewerNotice,
  room: () => rtc.status === 'connected' ? rtc.room : null,
  sharing: () => rtc.screenShareActive, activity: () => currentActivity.value,
});
const { captureRequest, captureSourceType, captureQuality, captureCustomQuality, selectedCaptureSourceId,
  captureFollowGameAvailable, captureSourceNotice, captureAudioCapabilityReady, captureAudioCapabilityFailed,
  captureAudioMode, captureShareAudio, nativeSourceLoading, nativeSourceError, nativeSourceChooserGeneration,
  selectCaptureSource, chooseCaptureSource, refreshVisibleSourceThumbnails, reportRenderedPreviews, updateCaptureShareAudio,
  saveCapturePreferences, preloadCaptureSources } = captureSelection;
function requestNativeScreenSource(capabilities: Promise<Record<string, { available: boolean; reason: string }>>) {
  return captureSelection.requestNativeScreenSource(capabilities, requestedGame);
}
async function changeScreenShareQuality(quality: ScreenShareQualityId,
  customQuality = localParticipant.value?.isScreenShareEnabled ? rtc.currentCustomScreenShareQuality : captureCustomQuality.value) {
  const snapshot = { ...customQuality };
  const applied = localParticipant.value?.isScreenShareEnabled ? await rtc.setScreenShareQuality(quality, snapshot) : true;
  if (applied) {
    captureQuality.value = quality;
    captureCustomQuality.value = snapshot;
    saveCapturePreferences(quality);
  }
  return applied;
}
async function changeScreenShareAudio(enabled: boolean) {
  const mode = rtc.currentScreenShareAudioMode;
  if (!await rtc.setScreenShareAudioEnabled(enabled)) return false;
  try { saveScreenShareAudioPreference(mode, enabled); }
  catch { viewerNotice.value = '本次声音设置已生效，但未能保存。'; }
  return true;
}
const rtc = reactive(useRtcRoom({
  inputDeviceId: audioPreferences.inputDeviceId.value,
  screenShareQuality: captureQuality.value,
  customScreenShareQuality: captureCustomQuality.value,
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
  output: audioOutput,
  desktop,
  canStart: () => audioOutput.available.value && rtc.status !== 'joining' && rtc.status !== 'reconnecting'
    && !rtc.busySources.includes(Track.Source.Microphone),
  publishedTrack: () => {
    void rtc.revision;
    if (rtc.status !== 'connected' || !rtc.microphoneEnabled) return undefined;
    const publication = rtc.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    return publication && !publication.isMuted ? publication.track?.mediaStreamTrack : undefined;
  },
}));

const microphoneDevices = reactive(useMicrophoneDevices({
  preferences: audioPreferences,
  desktop,
  stopTest: () => microphoneTest.stop(),
  changeInput: (deviceId) => rtc.setMicrophoneDeviceId(deviceId),
  inputLost: async () => {
    const room = rtc.room;
    await rtc.setMediaEnabled(Track.Source.Microphone, false);
    if (room && rtc.room === room) rtc.notice = '所选麦克风已断开，已停止发声。请检查设备或在语音设置中重新选择。';
  },
}));

watch(() => rtc.playbackContext, (context, _, onCleanup) => {
  if (!context) return;
  const binding = audioOutput.bindContext(context);
  void binding.ready.catch(() => {});
  onCleanup(binding.release);
}, { flush: 'sync' });

// 预先恢复被静音成员的订阅策略；之后只有跨越 0% 时才更新网络订阅。
audioPreferences.mutedParticipantIdentities()
  .forEach((identity) => rtc.setRemoteAudioSubscribed(identity, false));
const removeCloseListener = desktop?.onClose(async () => {
  const diagnosticFlush = diagnosticReport.flush();
  selectCaptureSource(null);
  viewingWindows.value?.closeAll();
  await reportOfflineBeforeClose();
  try { await microphoneTest.stop(); }
  finally {
    try { await rtc.leave(); }
    finally { await diagnosticFlush; desktop.finishClose(); }
  }
});
onScopeDispose(() => {
  joinAttempt++;
  viewingWindows.value?.closeAll();
  removeCloseListener?.();
  closeGroupEditor(); groupActionRequest?.abort();
  detailRequest?.abort(); listRequest?.abort(); void rtc.leave();
});
watch(() => rtc.status, (status) => { if (status === 'idle') selectCaptureSource(null); });
const groups = ref<GroupSummary[]>([]);
const selectedGroupId = ref<string | null>(null);
const selectedGroupDetail = ref<GroupDetail | null>(null);
const joinedGroupDetail = ref<GroupDetail | null>(null);
const groupError = ref('');
const summaryError = ref<string | null>(null);
const groupLoading = ref(false);
const initialGroupsLoaded = ref(false);
const initialChatGroupId = ref<string | null>(null);
const initialLoading = useInitialLoading(() => initialGroupsLoaded.value && !groupLoading.value
  && (!selectedGroupId.value || initialChatGroupId.value === selectedGroupId.value),
  (stage, durationMs) => desktop?.reportStartupTiming?.(stage, durationMs));
watch(initialLoading, loading => { if (!loading) emit('ready'); }, { flush: 'sync' });
const editorOpen = ref(false);
const editingGroup = ref<GroupDetail | null>(null);
const management = ref<{ group: GroupDetail; mode: 'invite' | 'members' | 'transfer' | 'leave' | 'dissolve' } | null>(null);
let detailRequest: AbortController | null = null;
let listRequest: AbortController | null = null;
let groupActionRequest: AbortController | null = null;
let groupEditorGeneration = 0;
const { groupPresences, presenceConnectionLost, refreshGroupPresence } = useGroupPresences(selectedGroupId,
  () => selectedGroupDetail.value, loadGroup);
let roomOccupancyRequest: AbortController | null = null;
let joinAttempt = 0;
const { showActivity, showLastOnline, error: activityVisibilityError, setShowActivity, setShowLastOnline } = usePresenceVisibility(props.user.id);
const ownPresence = useOwnPresence(props.user.id, { showActivity, showLastOnline }, desktop);
const { currentActivity, sharedActivity, publicPresenceStatus, personalPresenceLabel,
  presenceMode, presenceReady, presencePreferenceError, presenceSyncing, presenceSyncError,
  sendHeartbeat, changePresenceMode, startPresenceHeartbeat, updateOwnPresenceStatus, prepareLogout, reportOfflineBeforeClose } = ownPresence;
defineExpose({ prepareLogout });
const currentGame = computed(() => desktop && currentActivity.value?.type === 'GAME' ? currentActivity.value : null);
const gameShareBusy = computed(() => !connected.value || !!captureRequest.value || screenShareLimitReached.value
  || rtc.busySources.includes(Track.Source.ScreenShare) || rtc.screenShareQualityBusy || rtc.screenShareSourceBusy);
async function shareCurrentGame() {
  if (!currentGame.value || gameShareBusy.value || rtc.screenShareActive) return;
  requestedGame = { ...currentGame.value, windowIds: [...(currentGame.value.windowIds ?? [])] };
  try {
    await rtc.toggleMedia(Track.Source.ScreenShare);
  } finally { requestedGame = null; }
}
async function shareAndRecord() {
  if (!desktop || gameShareBusy.value || rtc.screenShareActive || recording.busy.value) return;
  const room = rtc.room;
  await rtc.toggleMedia(Track.Source.ScreenShare);
  // 取消、启动失败或切房后不录制；录制模块还会核对当前轨道与采集资格。
  if (!appDisposed && rtc.room === room && connected.value && rtc.screenShareActive) await recording.start();
}
const activityMappings = useActivityMappings(props.user.id, desktop);
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
  const cacheRevision = accountCache.revision;
  detailRequest?.abort();
  const request = new AbortController();
  detailRequest = request;
  if (!keepExisting) selectedGroupDetail.value = null;
  groupError.value = '';
  groupLoading.value = !keepExisting;
  if (!keepExisting) void accountCache.read<GroupDetail>('members', groupId).then(cached => {
    const valid = cached?.id === groupId && Array.isArray(cached.members)
      && cached.members.every(member => member && typeof member.userId === 'string' && typeof member.nickname === 'string');
    if (cached && !valid) void accountCache.discard('members', groupId);
    if (valid && !request.signal.aborted
        && selectedGroupId.value === groupId && groupLoading.value && !selectedGroupDetail.value) {
      selectedGroupDetail.value = { ...cached, ...selectedGroup.value, members: cached.members };
    }
  });
  try {
    const detail = await findGroup(groupId, request.signal);
    if (!request.signal.aborted && selectedGroupId.value === groupId) {
      selectedGroupDetail.value = detail;
      if (joinedGroupId.value === groupId) joinedGroupDetail.value = detail;
      if (management.value?.group.id === groupId) management.value.group = detail;
      if (accountCache.revision === cacheRevision) void accountCache.write('members', groupId, detail);
    }
  } catch (error) {
    if (!request.signal.aborted) {
      if (selectedGroupId.value === groupId) {
        groupError.value = error instanceof Error ? error.message : '无法读取群组资料';
      }
      // 旧预览不覆盖当前提示；若它仍是通话群，失去成员资格仍须正常离房。
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) {
        void accountCache.revokeGroup(groupId);
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

function retryGroupSync() {
  if (groupError.value && selectedGroupId.value) void loadGroup(selectedGroupId.value, true);
  if (presenceConnectionLost.value) refreshGroupPresence();
}

async function refreshGroups(refreshDetail = true, refreshOccupancy = true) {
  listRequest?.abort();
  const request = new AbortController();
  listRequest = request;
  try {
    const result = await findGroups(request.signal);
    if (request.signal.aborted) return;
    for (const previous of groups.value) {
      if (!result.some(group => group.id === previous.id)) void accountCache.revokeGroup(previous.id);
    }
    accountCache.allowGroups(result.map(group => group.id));
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
  } finally {
    if (!request.signal.aborted) initialGroupsLoaded.value = true;
    if (listRequest === request) listRequest = null;
  }
}
let groupListRefreshTimer: ReturnType<typeof setInterval> | null = null;
let roomOccupancyRefreshTimer: ReturnType<typeof setInterval> | null = null;
let lastActivationRefreshAt = 0;
function refreshOnActivation() {
  if (document.visibilityState === 'hidden' || Date.now() - lastActivationRefreshAt < 2_000) return;
  lastActivationRefreshAt = Date.now();
  void updateOwnPresenceStatus();
  void sendHeartbeat();
  roomSummaryRefreshVersion.value++;
  if (!listRequest) void refreshGroups(false);
  if (selectedGroupId.value) refreshGroupPresence();
}
function handleVisibilityChange() {
  refreshOnActivation();
}
onMounted(() => {
  void desktop?.prepareCapture().catch(() => { if (!appDisposed) console.warn('capture preparation request failed'); });
  startPresenceHeartbeat();
  refreshOnActivation();
  window.addEventListener('focus', refreshOnActivation);
  window.addEventListener('online', handlePresenceNetworkRestored);
  window.addEventListener('offline', handlePresenceNetworkLost);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  groupListRefreshTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void refreshGroups(false, false);
  }, GROUP_LIST_REFRESH_INTERVAL_MS);
  roomOccupancyRefreshTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') {
      if (groups.value.length > 0) void refreshRoomOccupancies();
    }
  }, ROOM_OCCUPANCY_REFRESH_INTERVAL_MS);
});
watch(selectedGroupId, () => { groupActionRequest?.abort(); });
function handlePresenceNetworkRestored() {
  void updateOwnPresenceStatus();
  void sendHeartbeat();
  roomSummaryRefreshVersion.value++;
  void refreshRoomOccupancies(true);
  if (selectedGroupId.value && document.visibilityState !== 'hidden') {
    refreshGroupPresence();
  }
}
function handlePresenceNetworkLost() {
  presenceConnectionLost.value = true;
}
onScopeDispose(() => {
  window.removeEventListener('focus', refreshOnActivation);
  window.removeEventListener('online', handlePresenceNetworkRestored);
  window.removeEventListener('offline', handlePresenceNetworkLost);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  roomOccupancyRequest?.abort();
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
const settingsPresented = ref(false);
const settingsView = ref<InstanceType<typeof SettingsView> | null>(null);
// 覆盖只影响绘制；保留聊天和观看尺寸，视频需求由各个观看位置单独控制。
const settingsCovered = ref(false);
const personalMenuOpen = ref(false);
const profileCardsBlocked = computed(() => Boolean(props.interactionBlocked || settingsOpen.value || !mainWindowVisible.value
  || editorOpen.value || management.value || captureRequest.value || pendingSwitchGroupId.value || rtc.remoteControlRequest));
const personalCardActive = computed(() => settingsOpen.value
  ? Boolean(settingsView.value) && !settingsView.value?.interactionBlocked && !settingsView.value?.leaving
  : !profileCardsBlocked.value);
watch(profileCardsBlocked, blocked => { if (blocked) personalMenuOpen.value = false; });
const recording = useRecording({
  onStarted: () => { void callSounds.recordingStarted(); },
  onSaved: () => { void callSounds.recordingStopped(); },
  track: () => rtc.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack,
  canStart: () => rtc.screenShareActive && !rtc.screenShareAudioRestricted && !rtc.screenShareQualityBusy
    && !rtc.screenShareSourceBusy && !rtc.busySources.includes(Track.Source.ScreenShare),
  voices: (settings) => {
    void rtc.revision;
    const tracks: { track: MediaStreamTrack; gain: number }[] = [];
    const room = rtc.room;
    if (!room) return tracks;
    if (settings.microphone && rtc.microphoneIntent && rtc.microphoneEnabled) {
      const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (publication?.track && !publication.isMuted) tracks.push({ track: publication.track.mediaStreamTrack, gain: 1 });
    }
    if (settings.friends && rtc.listening) {
      for (const participant of room.remoteParticipants.values()) {
        const publication = participant.getTrackPublication(Track.Source.Microphone);
        const track = publication?.track;
        const gain = remotePlaybackVolume(participant.identity);
        if (track instanceof RemoteAudioTrack && publication?.isSubscribed && !publication.isMuted && gain > 0) {
          tracks.push({ track: track.mediaStreamTrack, gain: Math.min(gain, track.getVolume()) });
        }
      }
    }
    return tracks;
  },
});
const settingsSection = ref<SettingsSectionId>('account');
const appNotice = ref<{ id: number; message: string; kind?: 'success'; source: string } | null>(null);
let appNoticeId = 0;
function showAppNotice(message: string, source: string, kind?: 'success') {
  appNotice.value = { id: ++appNoticeId, message, source, kind };
}
function dismissAppNotice() {
  if (appNotice.value?.source === 'update') emit('dismissUpdateWarning');
  appNotice.value = null;
}
watch(() => rtc.noticeEvent, event => { if (event) showAppNotice(event.message, 'rtc'); }, { immediate: true });
watch(viewerNoticeEvent, event => { if (event) showAppNotice(event.message, 'viewer'); }, { immediate: true });
watch(recording.noticeEvent, event => {
  if (event && (!settingsOpen.value || settingsSection.value !== 'recording')) showAppNotice(event.message, 'recording');
});
watch(audioOutput.notice, message => {
  if (message && (!settingsOpen.value || settingsSection.value !== 'audio')) showAppNotice(message, 'audioOutput');
}, { flush: 'sync' });
watch([settingsOpen, settingsSection], () => {
  if (settingsOpen.value && ((settingsSection.value === 'audio' && appNotice.value?.source === 'audioOutput')
      || (settingsSection.value === 'recording' && appNotice.value?.source === 'recording' && !appNotice.value.kind))) {
    dismissAppNotice();
  }
});
watch(recording.successNotice, notice => { if (notice) showAppNotice(notice.message, 'recording', 'success'); });
watch(() => props.startupUpdateWarning, message => { if (message) showAppNotice(message, 'update'); }, { immediate: true });
const settingsReturnFocus = ref<HTMLElement | null>(null);
const viewingWindows = ref<InstanceType<typeof ScreenShareWindows> | null>(null);
const viewingTarget = ref<HTMLElement | null>(null);
const voicePanelMotion = useInlineViewingMotion(viewingTarget, () => viewingWindows.value?.inlineExpanded ?? false);
const viewerInputBlocked = computed(() => Boolean(props.interactionBlocked || settingsOpen.value || editorOpen.value
  || management.value || captureRequest.value || pendingSwitchGroupId.value || rtc.remoteControlRequest || rtc.status !== 'connected'));
watch(viewerInputBlocked, (blocked) => { if (blocked) viewingWindows.value?.disarmAll(); }, { flush: 'sync' });
const mutedShares = ref<string[]>([]);
const departingGroupId = ref<string | null>(null);
const callbarLeaving = ref(false);
watch(() => rtc.room, (room) => { if (room) mutedShares.value = []; }, { flush: 'sync' });

async function openSettings(section: SettingsSectionId, event: Event | HTMLElement) {
  if (settingsOpen.value) { await settingsView.value?.selectSection(section); return; }
  settingsReturnFocus.value = event instanceof HTMLElement ? event
    : event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  settingsSection.value = section;
  settingsPresented.value = true;
  settingsOpen.value = true;
  await nextTick();
  document.querySelector<HTMLElement>('.settings-header h1')?.focus();
}

async function closeSettings() {
  // 停止会立即撤销试听资格；资源收尾与退场并行，不能让原生停止等待挡住动画。
  const stopped = microphoneTest.stop();
  settingsOpen.value = false;
  await nextTick();
  settingsReturnFocus.value?.focus();
  try { await stopped; }
  catch { if (!appDisposed) viewerNotice.value = '停止麦克风试听时发生问题，请重启应用后再试。'; }
}

async function finishSettingsLeave() {
  if (settingsOpen.value) return;
  const target = settingsReturnFocus.value;
  const restoreFocus = document.activeElement === target || document.activeElement === document.body;
  settingsPresented.value = false;
  await nextTick();
  if (settingsOpen.value) return;
  // 移回同一名片会让浏览器丢失焦点；用户已经操作其他区域时不再抢回焦点。
  if (restoreFocus && target?.isConnected) target.focus();
  settingsReturnFocus.value = null;
}

const selectedGroup = computed(() => groups.value.find((group) => group.id === selectedGroupId.value) ?? null);
const selectedGroupIndex = computed(() => groups.value.findIndex((group) => group.id === selectedGroupId.value));
const joinedGroup = computed(() => groups.value.find((group) => group.id === joinedGroupId.value) ?? null);
const callbarGroup = computed(() => joinedGroup.value
  ?? groups.value.find((group) => group.id === joiningGroupId.value)
  ?? groups.value.find((group) => group.id === departingGroupId.value)
  ?? null);
const callbarStatus = computed(() => callbarLeaving.value ? '正在退出'
  : STATUS_LABELS[joiningGroupId.value && rtc.status === 'idle' ? 'joining' : rtc.status]);
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
watch(() => connected.value ? rtc.room : null, (room, _, onCleanup) => {
  if (!desktop || !room) return;
  // 避开入房建链与声音初始化；这里只准备图形环境，不创建采集来源。
  const timer = setTimeout(() => {
    void desktop.prepareCapture(true).catch(() => console.warn('capture graphics preparation failed'));
  }, 1000);
  onCleanup(() => clearTimeout(timer));
});
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
const memberOnlineStatus = (member: Pick<GroupMember, 'userId'>) => {
  if (member.userId === props.user.id) return publicPresenceStatus.value;
  return groupPresences.value[member.userId]?.status ?? 'OFFLINE';
};
const memberActivity = (member: Pick<GroupMember, 'userId'>) => {
  const activity = member.userId === props.user.id
    ? sharedActivity.value
    : (groupPresences.value[member.userId]?.activityType === 'GAME' || groupPresences.value[member.userId]?.activityType === 'MUSIC')
      && groupPresences.value[member.userId]?.activityName
      && groupPresences.value[member.userId]?.activityStartedAt
      ? { type: groupPresences.value[member.userId].activityType!, name: groupPresences.value[member.userId].activityName!,
          startedAt: groupPresences.value[member.userId].activityStartedAt! }
      : null;
  if (memberOnlineStatus(member) === 'OFFLINE' || !activity) return null;
  return { type: activity.type, text: activity.type === 'MUSIC' ? `正在听 ${activity.name}` : `正在玩 ${activity.name}`,
    startedAt: activity.type === 'GAME' ? activity.startedAt : undefined };
};
const personalActivityStatus = computed(() => memberActivity({ userId: props.user.id }));
const orderedMembers = computed(() => {
  const members = selectedGroupDetail.value?.members ?? [];
  return [...members.filter((member) => memberOnlineStatus(member) !== 'OFFLINE'),
    ...members.filter((member) => memberOnlineStatus(member) === 'OFFLINE')];
});
const memberStatusLabel = (member: GroupMember) => {
  const status = memberOnlineStatus(member);
  const activity = memberActivity(member);
  const label = PRESENCE_STATUS_LABELS[status] ?? PRESENCE_STATUS_LABELS.OFFLINE;
  return activity ? `${label} · ${activity.text}` : label;
};
const participantAvatar = (identity: string) => identity === `user-${props.user.id}` ? props.user.avatar
  : currentMembers.value.find((member) => `user-${member.userId}` === identity)?.avatar ?? '';
const voiceOverlay = useVoiceOverlay({
  userId: props.user.id, room: () => rtc.room, revision: () => rtc.revision,
  status: () => rtc.status, microphone: () => rtc.microphoneEnabled, listening: () => rtc.listening,
  avatar: participantAvatar, bridge: window.lycanVoiceOverlay,
});
const previewParticipantName = (identity: string, displayName: string) =>
  selectedGroupDetail.value?.members.find((member) => `user-${member.userId}` === identity)?.nickname ?? displayName;
const previewParticipantAvatar = (identity: string) =>
  selectedGroupDetail.value?.members.find((member) => `user-${member.userId}` === identity)?.avatar ?? '';
const groupParticipants = computed(() => showingJoinedGroup.value ? rtc.participants : []);
const activeScreenShareCount = computed(() => {
  void rtc.revision;
  return rtc.participants.filter((participant) => participant.isScreenShareEnabled).length;
});
const remoteControlCanRequest = (identity: string) => rtc.remoteControlAvailable[identity] === true;
const remoteControlPlaceholder = (identity: string) => {
  const presentation = rtc.remoteControlPresentations[identity];
  if (!presentation || presentation.public || presentation.identity === rtc.room?.localParticipant.identity) return '';
  return '正在被 ' + previewParticipantName(presentation.identity,
    rtc.participants.find(participant => participant.identity === presentation.identity)?.name || presentation.identity) + ' 控制中';
};
const remoteControlIsPending = (identity: string) => rtc.remoteControlPending?.identity === identity;
const remoteControlIsActive = (identity: string) => rtc.remoteControlActive?.identity === identity;
// 测试期的客户端软限制，不代表服务端并发容量；后续按实测逐步移除。
const screenShareLimitReached = computed(() => activeScreenShareCount.value >= 8 && !localParticipant.value?.isScreenShareEnabled);
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
  viewingWindows.value?.closeAll();
  const attempt = ++joinAttempt;
  selectedGroupId.value = groupId;
  pendingSwitchGroupId.value = null;
  joiningGroupId.value = groupId;
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
  if (joinedGroupId.value !== null) {
    pendingSwitchGroupId.value = groupId;
    return;
  }
  void joinGroup(groupId);
}

function leaveVoice() {
  selectCaptureSource(null);
  viewingWindows.value?.closeAll();
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
    if (ownPresence.stopped || attempt !== joinAttempt) return;
    roomSummaryRefreshVersion.value++;
    void refreshRoomOccupancies(true);
  }).catch(() => {
    if (!ownPresence.stopped && attempt === joinAttempt && joinedGroupId.value === null && joiningGroupId.value === null) {
      viewerNotice.value = '退出语音时发生问题，请重启应用后再试。';
    }
  });
  joinedGroupId.value = null;
  joinedGroupDetail.value = null;
  joiningGroupId.value = null;
  pendingSwitchGroupId.value = null;
  viewerNotice.value = '';
  void refreshGroups(true, false);
}

let audioToggleVersion = 0;
async function toggleMicrophone() {
  if (!connected.value || !localParticipant.value) return;
  const version = ++audioToggleVersion;
  const room = rtc.room;
  const wasEnabled = rtc.microphoneEnabled;
  await rtc.toggleMedia(Track.Source.Microphone);
  if (version === audioToggleVersion && room === rtc.room && connected.value && wasEnabled !== rtc.microphoneEnabled) {
    void callSounds.microphoneChanged(rtc.microphoneEnabled);
  }
}

async function toggleListening() {
  if (!connected.value) return;
  ++audioToggleVersion;
  const enabled = !listening.value;
  const changing = rtc.updateListeningState(enabled);
  if (rtc.needsAudioPlayback && enabled) {
    await rtc.enableAudioPlayback();
  }
  await changing;
}

const audioShortcutRoomId = ref<string | null>(null);
let audioShortcutRoomVersion = 0;
watch(() => connected.value ? rtc.room : null, room => {
  audioToggleVersion++;
  audioShortcutRoomId.value = room ? String(++audioShortcutRoomVersion) : null;
}, { immediate: true, flush: 'sync' });
const audioShortcuts = reactive(useAudioShortcuts(props.user.id, {
  roomId: () => audioShortcutRoomId.value,
  microphone: toggleMicrophone, listening: toggleListening,
  replay: recording.saveReplay, replayId: () => recording.state.value.replay?.id ?? null,
  modeChanged: rtc.setMicrophoneVoiceMode,
  transmissionChanged: rtc.setPushToTalkHeld,
}));

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

const supportedMicrophoneProcessing = computed(() => [audioPreferences.processing.noiseSuppression,
  audioPreferences.processing.autoGainControl, audioPreferences.processing.voiceEnhancement,
  audioPreferences.processing.echoCancellation]);
const microphoneProcessingEnabled = computed(() => supportedMicrophoneProcessing.value.every(Boolean));
const microphoneProcessingPartial = computed(() => !microphoneProcessingEnabled.value && supportedMicrophoneProcessing.value.some(Boolean));
function updateMicrophoneProcessing(enabled: boolean) {
  if (audioPreferences.setProcessing({ echoCancellation: enabled, noiseSuppression: enabled,
    autoGainControl: enabled, voiceEnhancement: enabled })) void rtc.setMicrophoneProcessing(audioPreferences.processing);
}
function updateVoiceMode(mode: VoiceMode, opener: HTMLElement) {
  if (mode === 'pushToTalk' && !audioShortcuts.bindings.pushToTalk) {
    void openSettings('shortcuts', opener);
    return;
  }
  void audioShortcuts.setVoiceMode(mode);
}

function updateOutputVolume(volume: number) {
  audioPreferences.setOutputVolume(volume);
}
function remotePlaybackVolume(identity: string) {
  return Math.min(AUDIO_VOLUME_MAX, participantVolume(identity) * outputVolume.value);
}
function remoteScreenSharePlaybackVolume(identity: string) {
  if (mutedShares.value.includes(identity)) return 0;
  return Math.min(AUDIO_VOLUME_MAX, screenShareVolume.value * outputVolume.value);
}

function requestParticipantControl(identity: string) {
  void rtc.requestRemoteControl(identity);
}

function toggleSharedAudio(identity: string) {
  mutedShares.value = mutedShares.value.includes(identity)
    ? mutedShares.value.filter((current) => current !== identity) : [...mutedShares.value, identity];
  remoteAudioTracks.value.filter((item) => item.participantIdentity === identity && item.source === Track.Source.ScreenShareAudio)
    .forEach((item) => item.track.setVolume(listening.value ? remoteScreenSharePlaybackVolume(identity) : 0));
}

function previewGroup(groupId: string) {
  const changed = selectedGroupId.value !== groupId;
  selectedGroupId.value = groupId;
  void loadGroup(groupId, !changed && selectedGroupDetail.value?.id === groupId);
  if (changed) void refreshRoomOccupancies();
  pendingSwitchGroupId.value = null;
  viewerNotice.value = '';
}
const diagnosticReport = useDiagnosticReport({
  room: () => rtc.room, participants: () => rtc.participants,
  settings: () => ({ quality: rtc.currentScreenShareQuality, customQuality: rtc.currentCustomScreenShareQuality,
    inputGain: inputGain.value, outputVolume: outputVolume.value,
    screenShareVolume: screenShareVolume.value, voiceVolumeBalance: voiceVolumeBalance.value,
    ...audioProcessing, viewerCount: viewingWindows.value?.count ?? 0 }),
});

function participantListening(participant: Participant) {
  return participant === localParticipant.value ? listening.value
    : participant.attributes['lycansync.listening'] !== 'false';
}

</script>

<template>
  <div class="app-shell">
    <header class="titlebar" :class="{ 'desktop-titlebar': desktop }">
      <div class="brand">lycanclaw</div>
      <div v-if="desktop" class="window-actions">
        <button aria-label="最小化窗口" @click="desktop.minimize()"><Minus :size="14" /></button>
        <button :aria-label="windowMaximized ? '还原窗口' : '最大化窗口'" @click="desktop.toggleMaximize()">
          <Copy v-if="windowMaximized" :size="14" /><Square v-else :size="14" />
        </button>
        <button aria-label="关闭窗口" @click="desktop.close()"><X :size="14" /></button>
      </div>
      <div v-else class="window-actions" aria-hidden="true"><span><Minus :size="14" /></span><span><Square :size="11" /></span><span><X :size="14" /></span></div>
    </header>
    <Transition name="app-notice-motion" mode="out-in" appear @before-leave="($event as HTMLElement).inert = true">
    <AppNotice v-if="appNotice" :key="appNotice.id" :message="appNotice.message" :kind="appNotice.kind" @dismiss="dismissAppNotice" />
    </Transition>
    <DialogTransition>
    <RemoteControlRequest v-if="rtc.remoteControlRequest" :key="rtc.remoteControlRequest.requestId"
      :name="previewParticipantName(rtc.remoteControlRequest.identity,
        rtc.participants.find(participant => participant.identity === rtc.remoteControlRequest?.identity)?.name || rtc.remoteControlRequest.identity)"
      :busy="rtc.remoteControlGranting" @reject="rtc.rejectRemoteControl" @allow="rtc.allowRemoteControl" />
    </DialogTransition>
    <div v-if="rtc.remoteControlOwner" class="remote-control-owner-status" role="status">
      正在由 {{ previewParticipantName(rtc.remoteControlOwner.identity,
        rtc.participants.find((participant) => participant.identity === rtc.remoteControlOwner?.identity)?.name || rtc.remoteControlOwner.identity) }} 控制
      <span>{{ rtc.remoteControlOwner.public ? '画面向频道公开' : '画面仅控制方可见' }}</span>
      <button type="button" @click="rtc.revokeRemoteControl">停止控制</button>
    </div>
    <div v-else-if="rtc.remoteControlCleanupPending" class="remote-control-owner-status" role="alert">
      远程输入尚未释放
      <button type="button" @click="rtc.retryRemoteControlCleanup">重试撤销</button>
    </div>
    <div v-else-if="rtc.remoteControlPending" class="remote-control-owner-status" role="status">
      {{ rtc.remoteControlPending.phase === 'preparing' ? '正在准备远程控制…' : '等待对方接受远程控制…' }}
      <button type="button" @click="rtc.cancelPendingRemoteControl()">取消申请</button>
    </div>
    <div v-else-if="rtc.remoteControlRestoring" class="remote-control-owner-status" role="status">正在恢复原共享…</div>
    <Transition name="app-loading">
      <div v-if="initialLoading" class="app-loading" role="status" aria-live="polite">
        <div class="app-loading-identity" data-identity="loading">
          <img v-if="user.avatar" :src="user.avatar" alt="" referrerpolicy="no-referrer" data-identity-avatar />
          <span v-else class="app-loading-avatar" data-identity-avatar><UserRound :size="26" aria-hidden="true" /></span>
          <strong data-identity-name>{{ user.nickname }}</strong>
          <span class="app-loading-status"><LoaderCircle :size="16" aria-hidden="true" />正在准备群聊…</span>
        </div>
      </div>
    </Transition>
    <div class="app-content" v-show="mainWindowVisible" :style="{ visibility: settingsCovered ? 'hidden' : undefined }" :inert="initialLoading || settingsOpen || !!rtc.remoteControlRequest"
      :aria-hidden="initialLoading || settingsOpen || undefined">
    <div class="workspace" :inert="editorOpen || !!management">
      <nav class="group-rail" aria-label="群组">
        <div class="group-list">
          <span v-if="selectedGroupIndex >= 0" class="group-selection-marker" aria-hidden="true"
            :style="{ '--selected-group-index': selectedGroupIndex }" />
          <button v-for="group in groups" :key="group.id" type="button" class="group-button"
            :class="{ 'is-selected': selectedGroupId === group.id, 'is-in-call': joinedGroupId === group.id }"
            :aria-label="`${group.name}${groupHasVoiceActivity(group.id) ? '，当前有语音成员' : ''}，单击预览，双击加入语音`" :aria-pressed="selectedGroupId === group.id"
            :title="group.name"
            @click="previewGroup(group.id)" @dblclick="requestJoin(group.id)" @keydown.enter.prevent="requestJoin(group.id)">
            <img v-if="group.avatar" :src="group.avatar" class="group-rail-avatar" alt="" />
            <span v-else>{{ group.name.slice(0, 1) }}</span>
            <span v-if="groupHasVoiceActivity(group.id)" class="group-call-badge" aria-hidden="true"><Volume2 :size="12" :stroke-width="2.6" /></span>
          </button>
        </div>
        <button class="group-button add-group" type="button" aria-label="创建群组" @click="openEditor"><Plus :size="17" /></button>
      </nav>
      <main class="group-main">
        <div v-if="selectedGroup" class="group-heading-content">
        <div class="group-header-region" :aria-hidden="viewingWindows?.inlineExpanded || undefined" :inert="viewingWindows?.inlineExpanded">
          <div class="group-header-clip">
            <header class="group-header">
              <div :key="selectedGroup.id" class="group-copy group-content-ready">
                <div class="group-title-row"><GroupMenu :key="selectedGroup.id" :group="selectedGroup" @select="openGroupAction" /></div>
                <p :title="selectedGroup.description || undefined">{{ selectedGroup.description }}</p>
              </div>
              <IconButton :label="joinedGroupId === selectedGroup.id ? '离开当前群组语音' : '加入当前群组语音'"
                :class="{ 'is-danger': joinedGroupId === selectedGroup.id }" :disabled="joiningGroupId !== null"
                @click="joinedGroupId === selectedGroup.id ? leaveVoice() : requestJoin(selectedGroup.id)">
                <LogOut v-if="joinedGroupId === selectedGroup.id" :size="18" /><Headphones v-else :size="18" />
              </IconButton>
            </header>
          </div>
        </div>
        <div v-if="pendingSwitchGroup && joinedGroup" class="switch-confirm" role="alert">
          <span>切换到“{{ pendingSwitchGroup.name }}”？当前共享将停止，进入新语音后麦克风默认开启。</span>
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
        </div>
        <Transition :css="false" @leave="voicePanelMotion.leave">
          <section v-if="showingJoinedGroup && groupParticipants.length > 0" ref="viewingTarget" class="voice-panel"
            :class="{ 'is-viewing': viewingWindows?.inlineExpanded }" aria-label="当前语音成员" />
        </Transition>
        <div class="group-conversation">
          <div class="conversation-main">
            <GroupChat v-if="selectedGroup" :key="selectedGroup.id" :group="selectedGroup"
              :sync-error="groupError || (presenceConnectionLost ? '暂时无法更新成员状态。' : '')" @retry-sync="retryGroupSync"
              :members="selectedGroupDetail?.members ?? []" :user="user" @initial-load="initialChatGroupId = $event" />
            <div v-else class="group-empty">
              <p v-if="groupError" role="alert">{{ groupError }}</p>
              <p v-else class="group-empty-hint">还没有群组，点击左侧的 + 创建一个开黑小队。</p>
              <button v-if="groupError" type="button" @click="refreshGroups()">重新读取群组</button>
            </div>
            <Transition enter-active-class="callbar-enter-active">
              <div v-if="callbarGroup || joiningGroupId" class="callbar-reveal" :class="{ 'is-leaving': callbarLeaving }" data-testid="callbar">
                <div class="callbar-content">
                  <footer class="callbar">
                    <div class="call-state" role="status">
                      <RadioTower v-if="connected || rtc.status === 'reconnecting'" :size="17" /><Headphones v-else :size="17" />
                      <span><strong>{{ callbarStatus }}</strong>
                        <small v-if="!callbarLeaving && connected && rtc.screenShareStarting">正在启动屏幕共享…</small>
                        <small v-else>{{ callbarGroup?.name }}{{ joinedGroup && selectedGroupId !== joinedGroup.id && selectedGroup ? ' · 正在浏览 ' + selectedGroup.name : '' }}</small>
                      </span>
                    </div>
                    <IconButton v-if="joinedGroup && selectedGroupId !== joinedGroup.id" label="返回当前通话群组" @click="previewGroup(joinedGroup.id)"><CornerUpLeft :size="17" /></IconButton>
                    <CallControls :connected="connected" :desktop="Boolean(desktop)"
                      :microphone-enabled="rtc.microphoneEnabled" :microphone-intent="rtc.microphoneIntent" :microphone-busy="rtc.busySources.includes(Track.Source.Microphone)"
                      :microphone-level="localMicrophoneLevel" :input-level-percent="localInputLevelPercent"
                      :listening="listening" :input-gain="inputGain" :output-volume="outputVolume"
                      :voice-volume-balance="voiceVolumeBalance" @voice-volume-balance="audioPreferences.setVoiceVolumeBalance"
                      :game-name="currentGame?.name" @share-game="shareCurrentGame" @share-and-record="shareAndRecord"
                      :voice-mode="audioShortcuts.voiceMode" :push-to-talk-binding="audioShortcuts.bindings.pushToTalk"
                      :shortcuts-ready="audioShortcuts.ready" :shortcuts-busy="audioShortcuts.busy" :shortcuts-supported="audioShortcuts.supported"
                      :processing-enabled="microphoneProcessingEnabled" :processing-partial="microphoneProcessingPartial" :microphone-error="audioShortcuts.error"
                      @voice-mode="updateVoiceMode" @processing="updateMicrophoneProcessing"
                      :sharing="rtc.screenShareActive" :share-limit-reached="screenShareLimitReached" :choosing-source="Boolean(captureRequest)"
                      :share-busy="rtc.busySources.includes(Track.Source.ScreenShare) || rtc.screenShareQualityBusy || rtc.screenShareSourceBusy"
                      :quality="rtc.screenShareActive ? rtc.currentScreenShareQuality : captureQuality"
                      :custom-quality="rtc.screenShareActive ? rtc.currentCustomScreenShareQuality : captureCustomQuality"
                      :share-audio="sharingAudio" :audio-mode="rtc.currentScreenShareAudioMode"
                      :share-audio-restricted="rtc.screenShareAudioRestricted"
                      :recording-active="recording.active.value" :recording-busy="recording.busy.value" :recording-elapsed="recording.elapsed.value"
                      :replay-active="recording.replayActive.value" :replay-saving="recording.state.value.replay?.saving"
                      :replay-error="!!recording.state.value.replay?.error" @save-replay="recording.saveReplay"
                      @recording="recording.active.value ? recording.stop() : recording.start()"
                      @recording-settings="openSettings('recording', $event)"
                      @microphone="toggleMicrophone" @listening="toggleListening"
                      @prepare-share="preloadCaptureSources"
                      @share="captureRequest ? selectCaptureSource(null) : rtc.toggleMedia(Track.Source.ScreenShare)"
                      @quality="changeScreenShareQuality" @share-audio="changeScreenShareAudio"
                      @input-gain="updateInputGain" @output-volume="updateOutputVolume" @settings="openSettings('audio', $event)" />
                    <IconButton :label="joiningGroupId ? '取消连接' : '离开语音'" class="is-danger"
                      :disabled="callbarLeaving || (!joinedGroup && joiningGroupId === null)" @click="leaveVoice"><LogOut :size="17" /></IconButton>
                  </footer>
                </div>
              </div>
            </Transition>
          </div>
          <GroupMembersPanel v-if="selectedGroup" :key="selectedGroup.id" :members="orderedMembers" :user="user" :loading="groupLoading"
            :group-id="selectedGroup.id" :profile-blocked="profileCardsBlocked || personalMenuOpen"
            :member-count="selectedGroupDetail?.memberCount"
            :failed="!!groupError" :status="memberOnlineStatus"
            :status-label="memberStatusLabel" :activity="memberActivity" :presences="groupPresences" />
        <aside v-else class="members-directory members-directory-empty" aria-label="群组成员" />
        <div v-if="settingsPresented" class="personal-card-space" aria-hidden="true" />
        <Teleport to="body" :disabled="!settingsPresented">
        <PersonalStatusCard :user="user" :status="publicPresenceStatus" :status-label="personalPresenceLabel"
          :aria-label="settingsOpen ? '个人状态与返回应用' : '个人状态与设置'"
          :class="{ 'settings-footer': settingsPresented }" @keydown.esc.stop="settingsOpen && settingsView?.closeSettings()"
          v-model:menu-open="personalMenuOpen" menu-enabled :active="personalCardActive"
          :presence-mode="presenceMode" :presence-ready="presenceReady" :presence-syncing="presenceSyncing"
          :presence-error="presencePreferenceError || presenceSyncError" @presence-mode="changePresenceMode"
          :activity-status="personalActivityStatus" @settings="openSettings" @logout="settingsOpen ? settingsView?.requestLogout() : emit('logout')">
          <IconButton :label="settingsOpen ? '返回应用' : '设置'" :disabled="settingsOpen && !personalCardActive"
            @click="settingsOpen ? settingsView?.closeSettings() : openSettings('account', $event)">
            <component :is="settingsOpen ? ArrowLeft : Settings" :size="19" />
          </IconButton>
        </PersonalStatusCard>
        </Teleport>
        </div>
      </main>
    </div>
    <DialogTransition>
    <GroupEntryDialog v-if="editorOpen" :group="editingGroup ?? undefined" :create-group="createGroupFromDialog"
      @joined="joinedFromCode" @close="closeGroupEditor" />
    </DialogTransition>
    <DialogTransition>
    <GroupManagementDialog v-if="management" :group="management.group" :mode="management.mode" :user-id="user.id"
      @updated="applyGroupDetail" @removed="removedFromGroup" @close="management = null" />
    </DialogTransition>
    </div>
    <Transition name="settings-page" @after-enter="settingsCovered = settingsOpen" @enter-cancelled="settingsCovered = false"
      @after-leave="finishSettingsLeave" @leave-cancelled="settingsPresented = true"
      @before-leave="settingsCovered = false; ($event as HTMLElement).inert = true">
    <SettingsView v-if="settingsOpen" ref="settingsView" :blocked="Boolean(props.interactionBlocked || rtc.remoteControlRequest || !mainWindowVisible)" v-model:section="settingsSection" :user="user" :desktop="Boolean(desktop)"
      @group-updated="applyGroupDetail" @group-removed="removedFromGroup"
      :audio-shortcuts="audioShortcuts" :call-sound-preferences="callSoundPreferences" :call-sounds="callSounds"
      :overlay="desktop ? voiceOverlay : undefined"
      :share-quality="rtc.screenShareActive ? rtc.currentScreenShareQuality : captureQuality"
      :custom-share-quality="rtc.screenShareActive ? rtc.currentCustomScreenShareQuality : captureCustomQuality"
      :change-share-quality="changeScreenShareQuality" :change-share-audio="changeScreenShareAudio" :shared-audio="sharingAudio"
      :recording="recording" :preferences="audioPreferences" :audio-output="audioOutput" :rtc="rtc" :microphone-test="microphoneTest" :microphone-devices="microphoneDevices" :diagnostic-report="diagnosticReport" :input-level-percent="localInputLevelPercent"
      :activity="currentActivity" :presence-status="publicPresenceStatus" :show-activity="showActivity" :show-last-online="showLastOnline" :activity-error="activityVisibilityError || presenceSyncError"
      :presence-mode="presenceMode" :presence-ready="presenceReady" :presence-syncing="presenceSyncing"
      :presence-error="presencePreferenceError" @presence-mode="changePresenceMode"
      :activity-mappings="activityMappings"
      @activity-visibility="setShowActivity" @last-online-visibility="setShowLastOnline"
      :save-profile="saveProfile" @close="closeSettings" @logout="emit('logout')" />
    </Transition>
    <DialogTransition>
    <ScreenSharePicker v-if="captureRequest" :key="nativeSourceChooserGeneration" ref="capturePicker" :sources="captureRequest.sources"
      v-model:source-type="captureSourceType" v-model:quality="captureQuality" v-model:custom-quality="captureCustomQuality" :share-audio="captureShareAudio"
      @update:share-audio="updateCaptureShareAudio"
      :selected-id="selectedCaptureSourceId" :audio-mode="captureAudioMode" :audio-ready="captureAudioCapabilityReady"
      :audio-failed="captureAudioCapabilityFailed" :loading="nativeSourceLoading" :error="nativeSourceError" :notice="captureSourceNotice"
      :follow-game-available="captureFollowGameAvailable"
      @choose="chooseCaptureSource" @refresh-thumbnails="refreshVisibleSourceThumbnails" @preview-loaded="reportRenderedPreviews"
      @close="selectCaptureSource(null)" @confirm="selectCaptureSource(selectedCaptureSourceId, $event)" />
    </DialogTransition>
    <ScreenShareWindows ref="viewingWindows" :rtc="rtc" :group-name="joinedGroup?.name ?? ''"
      :recording-elapsed="recording.state.value.phase === 'recording' ? recording.elapsed.value : undefined"
      :inline-target="viewingTarget" :inline-visible="mainWindowVisible && !settingsPresented"
      :avatar="participantAvatar" :muted-shares="mutedShares"
      :control-placeholder="remoteControlPlaceholder"
      :input-blocked="viewerInputBlocked"
      @notice="viewerNotice = $event" @toggle-share-audio="toggleSharedAudio" @request-control="requestParticipantControl">
      <template #default="{ select, visible, focusedIdentity, watchingElsewhere }">
        <div v-for="participant in rtc.participants" :key="participant.identity" class="member-card" :data-scroll-key="participant.identity">
        <ParticipantCard :participant="participant"
          :focused="focusedIdentity === participant.identity" :watching-elsewhere="watchingElsewhere"
          :view-active="visible"
          :revision="rtc.revision" :avatar="participantAvatar(participant.identity)" :is-local="participant === localParticipant"
          :recording-elapsed="recording.state.value.phase === 'recording' ? recording.elapsed.value : undefined"
          :is-listening="participantListening(participant)" :local-microphone-enabled="rtc.microphoneEnabled"
          :remote-control-available="remoteControlCanRequest(participant.identity)"
          :private-control="remoteControlPlaceholder(participant.identity)"
          :remote-control-pending="remoteControlIsPending(participant.identity)"
          :remote-control-active="remoteControlIsActive(participant.identity)"
          :remote-control-name="previewParticipantName(participant.identity, participant.name || participant.identity)"
          :playback-volume="participantVolume(participant.identity)" :input-gain="inputGain" :output-volume="outputVolume"
          :share-audio="Boolean(participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track)"
          :share-muted="mutedShares.includes(participant.identity)" :share-audio-listening="listening"
          @toggle-share-audio="toggleSharedAudio(participant.identity)" @select="viewerNotice = ''; select(participant.identity)"
          @request-control="requestParticipantControl(participant.identity)" @cancel-control="rtc.cancelPendingRemoteControl(participant.identity)" @stop-control="rtc.exitRemoteControl"
          @toggle-audio="toggleParticipantAudio(participant.identity)" @volume-change="updateParticipantVolume(participant.identity, $event)"
          @input-gain-change="updateInputGain" @output-volume-change="updateOutputVolume"
          @toggle-microphone="toggleMicrophone" @toggle-listening="toggleListening" />
        </div>
      </template>
    </ScreenShareWindows>
    <RemoteAudio v-for="item in remoteAudioTracks" :key="item.track.sid" :track="item.track"
      :output="audioOutput"
      :context="rtc.playbackContext" :balance="voiceVolumeBalance && item.source === Track.Source.Microphone"
      @balance-error="audioPreferences.setVoiceVolumeBalance(false); viewerNotice = '成员语音音量平衡未能运行，已关闭该功能，语音继续按原音量播放。'"
      @playback-error="viewerNotice = '远端声音未能开始播放，请检查输出设备或重新连接语音。'"
      :volume="listening && audioOutput.available.value ? (item.source === Track.Source.ScreenShareAudio
        ? remoteScreenSharePlaybackVolume(item.participantIdentity) : remotePlaybackVolume(item.participantIdentity)) : 0" />
  </div>
</template>
