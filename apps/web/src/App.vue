<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, watch } from 'vue';
import { AudioLines, ChevronDown, ChevronUp, CornerUpLeft, HeadphoneOff, Headphones,
  LogOut, MessageSquareText, Mic, MicOff, Minus, MonitorUp, Plus, RadioTower, Search,
  Send, SlidersHorizontal, Square, UserRound, UsersRound, X } from '@lucide/vue';
import { RemoteAudioTrack, Track, type Participant } from 'livekit-client';
import ParticipantCard from './components/ParticipantCard.vue';
import RemoteAudio from './components/RemoteAudio.vue';
import IconButton from './components/IconButton.vue';
import { LOCAL_ROOMS } from './localRooms';
import { useRtcRoom } from './rtc/useRtcRoom';
import { useRoomSummary } from './rtc/useRoomSummary';

const STATUS_LABELS = { idle: '未加入语音', joining: '正在连接', connected: '语音已连接', reconnecting: '正在重连' };
const CALLBAR_EXIT_DURATION_MS = 180;
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
onScopeDispose(() => { selectCaptureSource(null); removeCaptureListener?.(); removeCloseListener?.(); });
watch(() => rtc.status, (status) => { if (status === 'idle') selectCaptureSource(null); });
const selectedGroupId = ref(LOCAL_ROOMS[0].id);
const joinedGroupId = ref<string | null>(null);
const joiningGroupId = ref<string | null>(null);
const pendingSwitchGroupId = ref<string | null>(null);
const nicknameGroupId = ref<string | null>(null);
// TODO: 登录接入后使用账号资料和会话恢复，移除本地昵称确认流程。
const displayName = ref(localStorage.getItem('lycansync.local-name') ?? '本地小狼');
const identityConfirmed = ref(false);
const listening = ref(true);
const volume = ref(0.72);
const lastVolume = ref(0.72);
const volumeOpen = ref(false);
const enlargedIdentities = ref<string[]>([]);
const membersExpanded = ref(true);
const viewerNotice = ref('');
const departingGroupId = ref<string | null>(null);
const callbarLeaving = ref(false);

const selectedGroup = computed(() => LOCAL_ROOMS.find((group) => group.id === selectedGroupId.value) ?? LOCAL_ROOMS[0]);
const joinedGroup = computed(() => LOCAL_ROOMS.find((group) => group.id === joinedGroupId.value) ?? null);
const callbarGroup = computed(() => joinedGroup.value ?? LOCAL_ROOMS.find((group) => group.id === departingGroupId.value) ?? null);
const pendingSwitchGroup = computed(() => LOCAL_ROOMS.find((group) => group.id === pendingSwitchGroupId.value) ?? null);
const localParticipant = computed(() => rtc.room?.localParticipant);
const connected = computed(() => rtc.status === 'connected');
const showingJoinedGroup = computed(() => joinedGroupId.value !== null && selectedGroupId.value === joinedGroupId.value);
const roomSummary = useRoomSummary(selectedGroupId, computed(() => !showingJoinedGroup.value));
const groupParticipants = computed(() => showingJoinedGroup.value ? rtc.participants : []);
const sharingParticipants = computed(() => groupParticipants.value.filter((participant) => participant.isScreenShareEnabled));
const activeScreenShareCount = computed(() => rtc.participants.filter((participant) => participant.isScreenShareEnabled).length);
// TODO: 服务端按群组原子分配并回收共享名额，处理并发开启、断线及失败；前端限制仅作提示。
const screenShareLimitReached = computed(() => activeScreenShareCount.value >= 8 && !localParticipant.value?.isScreenShareEnabled);
const sharingIdentityKey = computed(() => sharingParticipants.value.map((participant) => participant.identity).join('|'));
const enlargedParticipants = computed(() => enlargedIdentities.value
  .map((identity) => sharingParticipants.value.find((participant) => participant.identity === identity))
  .filter((participant) => participant !== undefined));

watch(sharingIdentityKey, (key) => {
  // SDK 轨道变化后清理失效选择，仍有共享时至少展示一路。
  const available = key ? key.split('|') : [];
  const retained = enlargedIdentities.value.filter((id) => available.includes(id)).slice(0, 4);
  enlargedIdentities.value = retained.length || !available.length ? retained : [available[0]];
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
async function joinGroup(groupId: string, nickname: string) {
  selectedGroupId.value = groupId;
  pendingSwitchGroupId.value = null;
  nicknameGroupId.value = null;
  joiningGroupId.value = groupId;
  enlargedIdentities.value = [];
  viewerNotice.value = '';
  volumeOpen.value = false;
  callbarLeaving.value = false;
  departingGroupId.value = null;

  if (joinedGroupId.value !== null) {
    rtc.leave();
    joinedGroupId.value = null;
  }

  const joined = await rtc.join(groupId, nickname.trim());
  if (joined) {
    localStorage.setItem('lycansync.local-name', nickname.trim());
    displayName.value = nickname.trim();
    identityConfirmed.value = true;
    joinedGroupId.value = groupId;
    listening.value = true;
    volume.value = lastVolume.value || 0.72;
  }
  joiningGroupId.value = null;
}

function requestJoin(groupId: string) {
  if (joiningGroupId.value !== null) return;
  selectedGroupId.value = groupId;
  enlargedIdentities.value = [];
  viewerNotice.value = '';

  if (joinedGroupId.value === groupId) {
    pendingSwitchGroupId.value = null;
    return;
  }
  if (joinedGroupId.value !== null) {
    pendingSwitchGroupId.value = groupId;
    return;
  }
  if (!identityConfirmed.value) {
    nicknameGroupId.value = groupId;
    return;
  }
  void joinGroup(groupId, displayName.value);
}

function submitNickname(event: Event) {
  event.preventDefault();
  if (nicknameGroupId.value === null || !displayName.value.trim()) return;
  void joinGroup(nicknameGroupId.value, displayName.value);
}

function leaveVoice() {
  const leavingGroupId = joinedGroupId.value ?? joiningGroupId.value;
  if (leavingGroupId !== null) {
    // RTC 立即离房，仅保留短暂的界面快照来完成底栏退场动画。
    departingGroupId.value = leavingGroupId;
    callbarLeaving.value = true;
  }
  rtc.leave();
  joinedGroupId.value = null;
  joiningGroupId.value = null;
  pendingSwitchGroupId.value = null;
  enlargedIdentities.value = [];
  viewerNotice.value = '';
  volumeOpen.value = false;
}

async function toggleMicrophone() {
  if (!connected.value || !localParticipant.value) return;
  const shouldEnableMicrophone = !localParticipant.value.isMicrophoneEnabled;
  if (shouldEnableMicrophone && !listening.value) {
    listening.value = true;
    volume.value = lastVolume.value || 0.72;
    void rtc.updateListeningState(true);
  }
  await rtc.setMediaEnabled(Track.Source.Microphone, shouldEnableMicrophone);
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
    void rtc.updateListeningState(false);
    volumeOpen.value = false;
    await rtc.setMediaEnabled(Track.Source.Microphone, false);
  } else {
    listening.value = true;
    void rtc.updateListeningState(true);
    volume.value = lastVolume.value || 0.72;
    await rtc.setMediaEnabled(Track.Source.Microphone, true);
  }
}

async function updateVolume(nextVolume: number) {
  const nextListening = nextVolume > 0;
  if (nextListening !== listening.value) {
    void rtc.updateListeningState(nextListening);
    await rtc.setMediaEnabled(Track.Source.Microphone, nextListening);
  }
  volume.value = nextVolume;
  listening.value = nextListening;
  if (nextVolume > 0) lastVolume.value = nextVolume;
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
}

function previewGroup(groupId: string) {
  selectedGroupId.value = groupId;
  pendingSwitchGroupId.value = null;
  enlargedIdentities.value = [];
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
      <span class="local-badge">本地调试</span>
      <div v-if="desktop" class="window-actions">
        <button aria-label="最小化窗口" @click="desktop.minimize()"><Minus :size="14" /></button>
        <button aria-label="最大化或还原窗口" @click="desktop.toggleMaximize()"><Square :size="11" /></button>
        <button aria-label="关闭窗口" @click="desktop.close()"><X :size="14" /></button>
      </div>
      <div v-else class="window-actions" aria-hidden="true"><span><Minus :size="14" /></span><span><Square :size="11" /></span><span><X :size="14" /></span></div>
    </header>
    <div v-if="rtc.notice || viewerNotice" class="notice" role="alert">{{ rtc.notice || viewerNotice }}</div>
    <div class="workspace">
      <nav class="group-rail" aria-label="群组">
        <button v-for="group in LOCAL_ROOMS" :key="group.id" type="button" class="group-button"
          :class="{ 'is-selected': selectedGroupId === group.id, 'is-in-call': joinedGroupId === group.id }"
          :aria-label="`${group.name}，单击预览，双击加入语音`" :aria-pressed="selectedGroupId === group.id"
          :data-tooltip="`${group.name} · 单击预览 / 双击加入`"
          @click="previewGroup(group.id)" @dblclick="requestJoin(group.id)" @keydown.enter.prevent="requestJoin(group.id)">
          {{ group.shortName }}<span v-if="joinedGroupId === group.id" class="group-call-dot" aria-hidden="true" />
        </button>
        <button class="group-button add-group" type="button" disabled aria-label="创建群组，尚未开放" data-tooltip="创建群组将在群组后端接入后开放"><Plus :size="17" /></button>
        <div class="rail-spacer" />
        <button class="group-button profile-button" type="button" disabled aria-label="个人设置，尚未开放" data-tooltip="个人设置尚未开放"><UserRound :size="17" /></button>
      </nav>
      <main class="group-main">
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
          <button type="button" class="confirm-button" @click="joinGroup(pendingSwitchGroup.id, displayName)">切换</button>
        </div>
        <section v-if="!showingJoinedGroup && roomSummary && roomSummary.participantCount > 0" class="voice-preview" aria-label="当前语音成员预览">
          <div class="voice-heading"><span><AudioLines :size="15" />语音中</span><small data-testid="room-summary-count">{{ roomSummary.participantCount }} 人</small></div>
          <div class="voice-preview-list">
            <span v-for="(name, index) in roomSummary.participantNames" :key="index" class="voice-preview-member"><i aria-hidden="true">{{ name.slice(0, 1) }}</i><strong>{{ name }}</strong></span>
          </div>
        </section>
        <section v-if="showingJoinedGroup && groupParticipants.length > 0" class="voice-panel" aria-label="当前语音成员">
          <div class="voice-heading">
            <span><AudioLines :size="15" />语音中</span>
            <span class="voice-heading-actions">
              <small data-testid="member-count">{{ groupParticipants.length }} 人 · {{ sharingParticipants.length }} / 8 路共享</small>
              <IconButton v-if="sharingParticipants.length > 0" :label="membersExpanded ? '收起其他成员' : '展开其他成员'"
                class="member-strip-toggle" @click="membersExpanded = !membersExpanded">
                <UsersRound :size="15" /><ChevronDown v-if="membersExpanded" :size="13" /><ChevronUp v-else :size="13" />
              </IconButton>
            </span>
          </div>
          <div v-if="sharingParticipants.length > 0" class="viewer-grid" :class="`viewer-count-${enlargedParticipants.length}`">
            <ParticipantCard v-for="participant in enlargedParticipants" :key="participant.identity" :participant="participant"
              :revision="rtc.revision" :is-local="participant === localParticipant" :is-listening="participantListening(participant)"
              variant="viewer" @notice="viewerNotice = $event" />
          </div>
          <div v-else class="participant-grid">
            <ParticipantCard v-for="participant in groupParticipants" :key="participant.identity" :participant="participant"
              :revision="rtc.revision" :is-local="participant === localParticipant" :is-listening="participantListening(participant)" />
          </div>
          <div v-if="sharingParticipants.length > 0 && membersExpanded" class="member-filmstrip" data-testid="member-filmstrip">
            <ParticipantCard v-for="participant in groupParticipants" :key="participant.identity" :participant="participant"
              :revision="rtc.revision" :is-local="participant === localParticipant" :is-listening="participantListening(participant)"
              variant="thumbnail" :selected="enlargedIdentities.includes(participant.identity)"
              @select="toggleEnlargedParticipant(participant.identity)" />
          </div>
        </section>
        <section class="chat-panel" :aria-label="`${selectedGroup.name}群聊`">
          <div class="chat-heading"><MessageSquareText :size="15" /><span>群聊</span></div>
          <div class="message-list">
            <p class="empty-state">文字聊天尚未开放，当前可使用语音和屏幕共享。</p>
          </div>
          <div class="composer"><button type="button" disabled aria-label="添加内容"><Plus :size="16" /></button>
            <input aria-label="消息内容" disabled placeholder="发送消息（尚未开放）" />
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
              <IconButton v-if="joinedGroup && selectedGroupId !== joinedGroup.id" label="返回当前通话群组" @click="selectedGroupId = joinedGroup.id"><CornerUpLeft :size="17" /></IconButton>
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
      <aside class="members-panel" aria-label="群组成员">
        <div class="members-header"><strong>成员</strong><Search :size="15" /></div>
        <p class="empty-state">成员列表尚未开放。语音参与者显示在上方语音区域。</p>
      </aside>
    </div>
    <div v-if="nicknameGroupId" class="dialog-backdrop">
      <section class="nickname-dialog" role="dialog" aria-modal="true" aria-labelledby="nickname-title">
        <div class="dialog-icon"><Headphones :size="20" /></div>
        <h2 id="nickname-title">加入 {{ LOCAL_ROOMS.find((group) => group.id === nicknameGroupId)?.name }}</h2>
        <p>这是本地调试身份。确认加入后才连接语音，并默认请求开启麦克风。</p>
        <form @submit="submitNickname">
          <label for="nickname">测试昵称</label>
          <input id="nickname" v-model="displayName" autofocus autocomplete="off" :maxlength="32" />
          <div class="dialog-actions"><button type="button" @click="nicknameGroupId = null">取消</button>
            <button type="submit" class="confirm-button" :disabled="!displayName.trim() || joiningGroupId !== null">{{ joiningGroupId ? '正在加入…' : '加入语音' }}</button>
          </div>
        </form>
      </section>
    </div>
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
