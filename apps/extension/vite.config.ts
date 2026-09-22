import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

function keepSingleOnnxWasm(): Plugin {
  return {
    name: 'keep-single-onnx-wasm',
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (name.startsWith('assets/') && name.includes('ort-wasm')) delete bundle[name];
      }
    },
  };
}

/** Extension pages reject CORS module loads (`crossorigin`) and absolute `/assets` URLs. */
function extensionPages(): Plugin {
  return {
    name: 'extension-pages',
    transformIndexHtml(html) {
      return html.replace(/<script\b[^>]*>|<link\b[^>]*>/gi, (tag) => {
        if (/^<link\b/i.test(tag) && /https?:/i.test(tag)) return tag;
        return tag.replace(/ crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g, '');
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [
    react(),
    extensionPages(),
    keepSingleOnnxWasm(),
    viteStaticCopy({
      targets: [
        { src: 'manifest.json', dest: '.' },
        { src: 'public/icons/*', dest: 'icons' },
        {
          src: '../../node_modules/@inboxsdk/core/pageWorld.js',
          dest: 'inboxsdk',
        },
        {
          src: '../../node_modules/@inboxsdk/core/background.js',
          dest: 'inboxsdk',
        },
        {
          src: '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
          dest: 'ort',
        },
        {
          src: '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
          dest: 'ort',
        },
      ],
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        mainWorld: resolve(__dirname, 'src/main-world/index.ts'),
        sidepanel: resolve(__dirname, 'src/sidepanel/index.html'),
        popup: resolve(__dirname, 'src/popup/index.html'),
        settings: resolve(__dirname, 'src/settings/index.html'),
        offscreen: resolve(__dirname, 'offscreen.html'),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'background') return 'background.js';
          if (chunk.name === 'content') return 'content.js';
          if (chunk.name === 'mainWorld') return 'main-world.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    alias: {
      '@gi/shared': resolve(__dirname, '../../packages/shared/src'),
      '@gi/gmail': resolve(__dirname, '../../packages/gmail/src'),
      '@gi/mailbox': resolve(__dirname, '../../packages/mailbox/src'),
      '@gi/ai': resolve(__dirname, '../../packages/ai/src'),
      '@gi/search': resolve(__dirname, '../../packages/search/src'),
      '@gi/agent': resolve(__dirname, '../../packages/agent/src'),
      '@gi/tracking': resolve(__dirname, '../../packages/tracking/src'),
    },
  },
});
