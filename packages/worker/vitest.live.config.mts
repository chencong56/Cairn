import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'
import { LIVE_SPEC_FILES } from './src/testing/test-groups.mjs'

/**
 * 阶段清单、靶场走查、外部站点与在线模型。
 * 不纳入 test / test:db / test:browser 默认必过路径，只通过 pnpm test:live 手动运行。
 * 其中不少用例仍会连 PostgreSQL 并启动 Chromium，所以沿用模板库，并且串行。
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: [...LIVE_SPEC_FILES],
    env: {
      CAIRN_WORKER_INTERNAL_PORT: '0',
    },
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    globalSetup: './vitest.global-setup.mts',
  },
  // NestJS 依赖 emitDecoratorMetadata，esbuild 不支持，需要 SWC 转译
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
