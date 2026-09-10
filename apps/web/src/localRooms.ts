interface LocalRoom {
  id: string;
  shortName: string;
  name: string;
  description?: string;
}

// TODO: 持久化群组接入后移除此调试入口，改为加载当前用户有权访问的群组。
export const LOCAL_ROOMS: LocalRoom[] = [
  { id: 'pack', shortName: '调', name: '本地调试房间', description: '仅用于本机语音与屏幕共享调试，不是已创建的正式群组。' },
];
