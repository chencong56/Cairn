import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'
import { DB_SPEC_FILES } from './src/testing/test-groups.mjs'

/**
 * PostgreSQL 集成测试。浏览器端口由用例自己伪造，不启动 Chromium。
 * 隔离库从同一模板克隆，因此串行。
 *
 * 并行尝试记录（2026-09-29）：openIsolatedDb 的克隆冲突自愈可解模板互斥，但
 * maxWorkers: 2 门控三轮确定性触发 lifecycle.integration「停机落在领取期间」的
 * 并行耦合（该用例单文件绿、负载下时序交错失守），且该区域当时正被另一会话改造。
 * 按「偶发/耦合即回退」纪律回退串行；待 lifecycle 区域稳定后可重试（预期收益 ~25s）。
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: [...DB_SPEC_FILES],
    env: {
      CAIRN_WORKER_INTERNAL_PORT: '0',
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: process.env.CI || process.env.CAIRN_TEST_RETRY ? 1 : 0,
    fileParallelism: false,
    globalSetup: './vitest.global-setup.mts',
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
