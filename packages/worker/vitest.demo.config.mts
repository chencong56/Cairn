import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'
import { DEMO_SPEC_FILES } from './src/testing/test-groups.mjs'

/**
 * 演示 / 验收档（DEMO）：验证「能力链走得通」的全链路演示，非回归守卫。
 * 默认套件（`pnpm test` / `test:browser`）不包含本档；按需通过 `test:demo`
 * 触发，改动上传/下载/录像/编写链路时由 verify:changed 的 L3 提示补跑。
 * 全链路真浏览器 + 真 PostgreSQL，串行执行。
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: [...DEMO_SPEC_FILES],
    env: {
      CAIRN_WORKER_INTERNAL_PORT: '0',
    },
    testTimeout: 180_000,
    hookTimeout: 180_000,
    retry: process.env.CI || process.env.CAIRN_TEST_RETRY ? 1 : 0,
    fileParallelism: false,
    globalSetup: './vitest.global-setup.mts',
  },
  // NestJS 依赖 emitDecoratorMetadata，esbuild 不支持，需要 SWC 转译
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
