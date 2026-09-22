import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
      'workers/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
    ],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
  resolve: {
    alias: {
      '@gi/shared': path.resolve(__dirname, 'packages/shared/src'),
      '@gi/gmail': path.resolve(__dirname, 'packages/gmail/src'),
      '@gi/mailbox': path.resolve(__dirname, 'packages/mailbox/src'),
      '@gi/ai': path.resolve(__dirname, 'packages/ai/src'),
      '@gi/search': path.resolve(__dirname, 'packages/search/src'),
      '@gi/agent': path.resolve(__dirname, 'packages/agent/src'),
      '@gi/tracking': path.resolve(__dirname, 'packages/tracking/src'),
    },
  },
});
