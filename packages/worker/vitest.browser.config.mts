import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'
import { BROWSER_SPEC_FILES } from './src/testing/test-groups.mjs'

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: [...BROWSER_SPEC_FILES],
    env: {
      CAIRN_WORKER_INTERNAL_PORT: '0',
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: process.env.CI || process.env.CAIRN_TEST_RETRY ? 1 : 0,
    fileParallelism: false,
    globalSetup: './vitest.global-setup.mts',
  },
  // NestJS 依赖 emitDecoratorMetadata，esbuild 不支持，需要 SWC 转译
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
