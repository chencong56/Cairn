import { requireReachableDb, setupTestTemplateDatabase } from './src/testing.js'

/**
 * 集成测试的库前置条件在建任何用例之前就成立，否则整个包失败。
 * 在 globalSetup 中预热模板库并跑全量迁移，使后续每个用例只需亚秒级克隆，不必重复 migration。
 * 返回的清理函数删除**本次自己建的**模板；多 project 配置只能在根配置声明一次 globalSetup。
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  await requireReachableDb()
  return setupTestTemplateDatabase()
}
