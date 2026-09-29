import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.spec.ts'],
    testTimeout: 15_000,
    // 同 db：集成用例的 beforeAll 要建库跑迁移，默认 10s 不够。
    hookTimeout: 60_000,
    retry: process.env.CI || process.env.CAIRN_TEST_RETRY ? 1 : 0,
    // 集成测试的库前置条件：连不上就整包失败，不静默少跑一半
    globalSetup: ['./vitest.global-setup.mts'],
    // 22 个 spec 连库；全仓并行时与 worker 集成组共挤主 PG 实例，
    // 限并发减轻争用（无限制时默认吃满核，实测把整体拖慢 2-4 倍）。
    maxWorkers: 3,
  },
  // NestJS 依赖 emitDecoratorMetadata，esbuild 不支持，需要 SWC 转译
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
