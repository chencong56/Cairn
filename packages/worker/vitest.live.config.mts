import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'
import { LIVE_SPEC_FILES } from './src/testing/test-groups.mjs'

/**
 * 会离开本机的巡检：公网站点，或在线模型。
 * 本地 setContent、127.0.0.1 和被拦截的保留域名不属于这里。
 * 不纳入 test / test:db / test:browser，只通过 pnpm test:live 手动运行。
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
