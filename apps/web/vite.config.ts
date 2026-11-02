import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 开发时：先 `npm run dev:server -- --port 4319 --dev-origin http://localhost:5173 --simulate`，再 `npm run dev:web`
const gateway = process.env.ZHONGSHU_GATEWAY ?? 'http://127.0.0.1:4319';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@zhongshu/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) } },
  server: { port: 5173, strictPort: true, proxy: { '/api': { target: gateway, ws: true, changeOrigin: true } } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
