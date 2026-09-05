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
      // TODO: 桌面打包时配置业务服务地址；Vite 开发代理不会随静态产物运行。
      // 只代理业务 HTTP；音视频和信令由浏览器直接连接 LiveKit。
      '/api': { target: 'http://127.0.0.1:18080' },
    },
  },
});
