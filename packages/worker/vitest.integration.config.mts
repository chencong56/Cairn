import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'
import {
  BROWSER_PARALLEL_SPEC_FILES,
  BROWSER_SERIAL_SPEC_FILES,
  DB_SPEC_FILES,
} from './src/testing/test-groups.mjs'

/**
 * worker 集成套件合并配置（仅供 `pnpm --filter @cairn/worker test` 使用）：
 * db 组与浏览器两档在同一调度器下并行，消除原先「fast → db → browser」
 * 三段 && 串接的空转。分档明细：
 *
 * - integration-db：真 PostgreSQL、假浏览器端口，maxWorkers: 2；
 * - browser-serial：连库真 Chromium，openIsolatedDb 自愈重试兜底，maxWorkers: 2；
 * - browser-parallel：不连库真 Chromium（独立 profile + 随机端口），maxWorkers: 2。
 *
 * 三档在同一调度池交错（vitest 4 约束：同 group 的 projects 必须同 maxWorkers），
 * 全部 maxWorkers: 2。曾试 browser-serial 3 路：三轮门控一轮触发 managed-page.lab（真 SDK、时序敏感）13 用例耦合失败，按纪律回退。CAIRN_BROWSER_PARALLEL=0 回退为全串行（排查偶发时的逃生舱：
 * 先切串行复现定性，再决定回退）。
 */
const base = {
  root: import.meta.dirname,
  env: {
    CAIRN_WORKER_INTERNAL_PORT: '0',
  },
  testTimeout: 60_000,
  hookTimeout: 60_000,
  retry: process.env.CI || process.env.CAIRN_TEST_RETRY ? 1 : 0,
  globalSetup: './vitest.global-setup.mts',
} as const

export default defineConfig({
  test:
    process.env.CAIRN_BROWSER_PARALLEL === '0'
      ? {
          ...base,
          include: [...DB_SPEC_FILES, ...BROWSER_SERIAL_SPEC_FILES, ...BROWSER_PARALLEL_SPEC_FILES],
          fileParallelism: false,
        }
      : {
          ...base,
          projects: [
            {
              test: {
                ...base,
                name: 'integration-db',
                include: [...DB_SPEC_FILES],
                // 组内串行：lifecycle「停机落在领取期间」竞态用例与 db 组并行
                // 确定性耦合（门控两轮复现）；串行的 ~79s 由 browser 档时间线吸收。
                maxWorkers: 2,
                fileParallelism: false,
              },
            },
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
