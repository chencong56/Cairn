import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'
import {
  BROWSER_PARALLEL_SPEC_FILES,
  BROWSER_SERIAL_SPEC_FILES,
} from './src/testing/test-groups.mjs'

/**
 * 浏览器集成测试：真 Chromium，页面来自 setContent / 127.0.0.1 / 被拦截的保留域名。
 *
 * 默认拆两个 project 受控并行（vitest 4 约束：同 group 的 projects 必须同
 * maxWorkers，故两档统一 2；3 路曾触发 managed-page.lab 时序耦合，已回退）：
 * - browser-serial：连 PostgreSQL 的文件。openIsolatedDb 内置克隆冲突自愈
 *   （剔除模板库残留连接后重试，兜底全量迁移）；
 * - browser-parallel：不连库的文件（独立临时 profile + 随机端口）。
 *
 * CAIRN_BROWSER_PARALLEL=0 为强制串行逃生舱：浏览器段出现偶发失败时，先用它
 * 复现定性（区分并行耦合与真实回归），再决定回退。
 */
const base = {
  root: import.meta.dirname,
  env: {
    CAIRN_WORKER_INTERNAL_PORT: '0',
  },
  testTimeout: 60_000,
  hookTimeout: 60_000,
  retry: process.env.CI || process.env.CAIRN_TEST_RETRY ? 1 : 0,
} as const

/** 只能在根配置声明一次：写进 base 展开到每个 project 会一次运行建多个模板，清理只认最后一个。 */
const globalSetup = './vitest.global-setup.mts'

export default defineConfig({
  test:
    process.env.CAIRN_BROWSER_PARALLEL === '0'
      ? {
          ...base,
          globalSetup,
          include: [...BROWSER_SERIAL_SPEC_FILES, ...BROWSER_PARALLEL_SPEC_FILES],
          fileParallelism: false,
        }
      : {
          ...base,
          globalSetup,
          projects: [
            {
              test: {
                ...base,
                name: 'browser-serial',
                include: [...BROWSER_SERIAL_SPEC_FILES],
                maxWorkers: 2,
              },
            },
            {
              test: {
                ...base,
                name: 'browser-parallel',
                include: [...BROWSER_PARALLEL_SPEC_FILES],
                maxWorkers: 2,
              },
            },
          ],
        },
  // NestJS 依赖 emitDecoratorMetadata，esbuild 不支持，需要 SWC 转译
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
