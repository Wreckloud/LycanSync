import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const webPort = Number(process.env.WEB_PORT ?? 4173);

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      // 浏览器开发使用此代理；Electron 由主进程转发到 LYCANSYNC_API_URL。
      // 只代理业务 HTTP；音视频和信令由浏览器直接连接 LiveKit。
      '/api': { target: 'http://127.0.0.1:18080' },
    },
  },
});
