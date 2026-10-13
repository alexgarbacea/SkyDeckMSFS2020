import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/web'),
  publicDir: path.resolve(__dirname, 'public'),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4500',
      '/ws': { target: 'ws://localhost:4500', ws: true },
    },
  },
  test: {
    root: __dirname,
    include: ['tests/**/*.test.ts'],
  },
} as never);
