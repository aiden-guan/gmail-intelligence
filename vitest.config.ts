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
      'apps/**/src/**/*.test.tsx',
      'convex/**/*.test.ts',
    ],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
  resolve: {
    alias: {
      '@pigeonbox/shared': path.resolve(__dirname, 'packages/shared/src'),
      '@pigeonbox/gmail': path.resolve(__dirname, 'packages/gmail/src'),
      '@pigeonbox/mailbox': path.resolve(__dirname, 'packages/mailbox/src'),
      '@pigeonbox/ai': path.resolve(__dirname, 'packages/ai/src'),
      '@pigeonbox/search': path.resolve(__dirname, 'packages/search/src'),
      '@pigeonbox/agent': path.resolve(__dirname, 'packages/agent/src'),
      '@pigeonbox/tracking': path.resolve(__dirname, 'packages/tracking/src'),
      '@pigeonbox/api-contract': path.resolve(__dirname, 'packages/api-contract/src'),
      '@pigeonbox/cloud-client': path.resolve(__dirname, 'packages/cloud-client/src'),
      '@pigeonbox/core': path.resolve(__dirname, 'packages/core/src'),
    },
  },
});
