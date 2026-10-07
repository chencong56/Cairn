import { requireReachableDb, setupTestTemplateDatabase } from '@cairn/db/testing'

/**
 * api 的集成测试真连 PostgreSQL，库不可用时整个包失败，不跳过。
 * 在 globalSetup 中预热模板库并跑全量迁移，使后续每个用例只需亚秒级克隆。
 * 返回的清理函数删除**本次自己建的**模板；多 project 配置只能在根配置声明一次 globalSetup。
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await requireReachableDb()
  return setupTestTemplateDatabase()
}
