import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/analyze': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});