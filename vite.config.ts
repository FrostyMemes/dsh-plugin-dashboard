import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/dsh-agent-control-center/',
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
});
