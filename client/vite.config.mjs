import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  server: {
    port: 5190,
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://localhost:3002' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
