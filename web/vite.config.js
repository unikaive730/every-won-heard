import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  publicDir: false,
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: `http://localhost:${process.env.PORT || 8787}`, changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(here, '..', 'dist'),
    emptyOutDir: true,
    // The AudioWorklet must stay a real file: audioWorklet.addModule() refuses a data: URL,
    // and Vite would otherwise inline this small module as base64.
    assetsInlineLimit(filePath) {
      if (filePath.endsWith('pcm-worklet.js')) return false;
      return undefined;
    },
  },
});
