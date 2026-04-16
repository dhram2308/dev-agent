import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared/src'),
      '@native': path.resolve(__dirname, '../native'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/__tests__/*.test.ts'],
    coverage: { reporter: ['text', 'lcov'], include: ['src/**/*.ts'] },
  }
});
