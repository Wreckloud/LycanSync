import { createApp } from 'vue';
import ControlsPreview from './ControlsPreview.vue';
import '../styles.css';
import '../settings/settings.css';
import '../chat/chat.css';
import '../viewing/callViewing.css';
import './preview.css';

// 独立开发入口不装载 AuthRoot，不读取账号，也不创建媒体或桌面会话。
createApp(ControlsPreview).mount('#root');
