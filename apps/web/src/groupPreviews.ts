export interface GroupMemberPreview {
  name: string;
  online: boolean;
  activity?: string;
}

interface GroupMessagePreview {
  sender: string;
  time: string;
  content: string;
}

interface GroupPreview {
  id: string;
  shortName: string;
  name: string;
  description?: string;
  members: GroupMemberPreview[];
  messages: GroupMessagePreview[];
}

// TODO: 用真实群组、成员和聊天接口替换预览数据；游戏和音乐状态须遵循用户隐私设置。
export const GROUPS: GroupPreview[] = [
  {
    id: 'pack',
    shortName: '开',
    name: '开黑小队',
    description: '今晚十点，随叫随到。',
    members: [
      { name: '小北', online: true, activity: '正在玩 永劫无间' },
      { name: '阿澈', online: true, activity: '正在听 Night Drive' },
      { name: '青岚', online: true },
      { name: '林雾', online: false },
      { name: '折枝', online: false },
    ],
    messages: [
      { sender: '阿澈', time: '21:32', content: '我把新地图路线发群里了，等会儿直接进语音。' },
      { sender: '小北', time: '21:36', content: '收到。我先开一会儿画面，大家看看落点。' },
    ],
  },
  {
    id: 'racing',
    shortName: '车',
    name: '周末车队',
    description: '周六晚上一起跑图。',
    members: [
      { name: '可乐', online: true, activity: '正在玩 极限竞速' },
      { name: '隼', online: true },
      { name: '朝汐', online: false },
    ],
    messages: [
      { sender: '可乐', time: '周六', content: '路线就按上次那条，缺一位直接喊朋友来。' },
    ],
  },
  {
    id: 'lounge',
    shortName: '摸',
    name: '摸鱼客厅',
    members: [
      { name: '折枝', online: true },
      { name: '林雾', online: false },
    ],
    messages: [
      { sender: '折枝', time: '昨天', content: '这个群先留着，谁在线就进来聊两句。' },
    ],
  },
];
