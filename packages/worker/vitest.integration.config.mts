import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'
import {
  BROWSER_PARALLEL_SPEC_FILES,
  BROWSER_SERIAL_SPEC_FILES,
  DB_SPEC_FILES,
} from './src/testing/test-groups.mjs'

/**
 * worker 集成套件合并配置（仅供 `pnpm --filter @cairn/worker test` 使用），三个 project：
 *
 * - browser-serial：连库真 Chromium，每个文件 openIsolatedDb 克隆自己的库；
 * - browser-parallel：不连库真 Chromium（独立 profile + 随机端口）；
 * - integration-db：真 PostgreSQL、假浏览器端口。
 *
 * 实际调度（2026-10-07 以 vitest 4 源码 groupSpecs 与两次时间线核对）：
 *
 * 1. browser-serial 与 browser-parallel 同属默认 groupOrder 0，共用**一个**池，上限都是 2。
 *    所以全套任意时刻最多 2 个浏览器文件在跑，不是「每档各 2 路」；「同 group 的 projects 必须同
 *    maxWorkers」是 vitest 4 的约束，两档都写 2 即为满足它。
 * 2. integration-db 因 `fileParallelism: false` 被 vitest 强制解析为 maxWorkers 1，落入单独的
 *    顺序组，**排在所有浏览器文件跑完之后**，一次一个文件；它并没有被浏览器档的时间线「吸收」。
 *    测试库换成内存盘容器后它只占约 35 秒，代价可以接受，故不为它另调结构。
 * 3. 现在的下限是浏览器档（约 300 秒，受 Chromium 与 2 路并发限制），与数据库无关。
 *
 * 曾试 browser-serial 3 路：三轮门控一轮触发 managed-page.lab（真 SDK、时序敏感）13 用例耦合失败，
 * 按纪律回退。当时测试库是慢库，耦合是否与之有关未验证；再试须连续多轮全绿才可采纳。
 * CAIRN_BROWSER_PARALLEL=0 回退为全串行（排查偶发时的逃生舱：先切串行复现定性，再决定回退）。
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

/**
 * globalSetup 只能在根配置声明一次：写进 base 再展开到每个 project，会让一次运行建 N 个模板，
 * 而清理只认最后一个，其余必漏（2026-09-30 引入、2026-10-07 修复）。
 */
const globalSetup = './vitest.global-setup.mts'

export default defineConfig({
  test:
    process.env.CAIRN_BROWSER_PARALLEL === '0'
      ? {
          ...base,
          globalSetup,
          include: [...DB_SPEC_FILES, ...BROWSER_SERIAL_SPEC_FILES, ...BROWSER_PARALLEL_SPEC_FILES],
          fileParallelism: false,
        }
      : {
          ...base,
          globalSetup,
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
