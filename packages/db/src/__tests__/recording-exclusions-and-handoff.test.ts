import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { parseDemonstrationFile } from '@cairn/authoring'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { createDemonstration, getDemonstration } from '../recordings/demonstrations.js'
import {
  listRecordingDraftExclusions,
  updateRecordingDraftExclusions,
  loadCleansingHints,
} from '../recordings/exclusions.js'
import { createScenarioFromRecordingHandoff } from '../recordings/handoff.js'
import { getRecordingDraft, listRecordingDrafts } from '../recordings/recordings.js'
import { deleteScenario, getScenario } from '../runs/scenarios.js'

describe.each(DRIVERS)(
  '%s recording draft exclusions and handoff',
  { timeout: 30_000 },
  (driver) => {
    let handle: DbHandle
    const actorId = newId()
    const otherId = newId()
    const targetId = newId()

    beforeAll(async () => {
      handle = await openContractDb(driver)
      const t = schemaFor(handle.db)
      for (const id of [actorId, otherId]) {
        await handle.db
          .insert(t.consoleAccounts)
          .values({ id, displayName: '测试用户', email: `${id}@example.test`, status: 'active' })
      }
      const [admin] = await handle.db
        .select()
        .from(t.consoleRoles)
        .where(eq(t.consoleRoles.key, 'admin'))
        .limit(1)
      if (admin) {
        for (const id of [actorId, otherId]) {
          await handle.db
            .insert(t.consoleAccountRoles)
            .values({
              consoleAccountId: id,
              consoleRoleId: admin.id,
              targetScopeMode: 'all',
              targetScopeIds: [],
            })
        }
      }
      await handle.db
        .insert(t.targets)
        .values({
          id: targetId,
          code: `th-${newId()}`,
          name: '排除与直通测试目标',
          entryUrl: 'https://example.test',
        })
    })

    afterAll(async () => {
      await handle?.close()
    })

    const actor = () => ({ id: actorId })
    const source = (
      flow = '      - aiInput: 订单号\n        value: 123\n      - aiTap: 查询\n      - aiAssert: 出现结果',
    ) =>
      parseDemonstrationFile({
        targetId,
        captureId: newId(),
        profile: 'midscene-yaml-flow@1',
        text: `web:\n  url: https://example.test\ntasks:\n  - name: 查询\n    flow:\n${flow}`,
      })

    it('manages draft exclusions with optimistic revision lock and loads cleansing hints', async () => {
      const created = await createDemonstration(
        handle.db,
        {
          source: source(),
          name: '测试排除与清洗',
          acknowledgedOmittedConfig: true,
          idempotencyKey: newId(),
        },
        actor(),
      )

      const draftId = created.recordingDraftId

      // 1. 初始排除名单为空
      const initial = await listRecordingDraftExclusions(handle.db, draftId)
      expect(initial).toEqual([])

      // 2. 加载清洗提示
      const hints = await loadCleansingHints(handle.db, draftId, targetId)
      expect(hints).toBeDefined()
      expect(Array.isArray(hints?.loginPrefixItemIds)).toBe(true)
      expect(Array.isArray(hints?.misfireItemIds)).toBe(true)

      // 3. 乐观锁冲突测试
      await expect(
        updateRecordingDraftExclusions(
          handle.db,
          draftId,
          {
            expectedRevision: 999,
            exclusions: [{ itemId: 'item-1', reason: 'manual_discard' }],
          },
          actor(),
        ),
      ).rejects.toMatchObject({ code: 'RECORDING_DRAFT_REVISION_MISMATCH' })

      // 4. 正确更新排除项，版本自增为 2
      const demo = await getDemonstration(handle.db, draftId, actorId)
      const factId0 = demo.source.facts[0]!.id
      const factId1 = demo.source.facts[1]!.id
      const updated = await updateRecordingDraftExclusions(
        handle.db,
        draftId,
        {
          expectedRevision: 1,
          exclusions: [
            { itemId: factId0, reason: 'login_prefix' },
            { itemId: factId1, reason: 'misfire_click' },
          ],
        },
        actor(),
      )
      expect(updated.revision).toBe(2)
      expect(updated.exclusions).toHaveLength(2)

      const reloaded = await listRecordingDraftExclusions(handle.db, draftId)
      expect(reloaded).toHaveLength(2)
      expect(reloaded.map((e) => e.itemId)).toEqual([factId0, factId1])
    })

    it('executes straight handoff to create a scenario draft without publishing versions', async () => {
      const created = await createDemonstration(
        handle.db,
        {
          source: source(),
          name: '直通回填测试',
          acknowledgedOmittedConfig: true,
          idempotencyKey: newId(),
        },
        actor(),
      )
      const draftId = created.recordingDraftId
      const demo = await getDemonstration(handle.db, draftId, actorId)
      const firstFactId = demo.source.facts[0]!.id

      // 排除第 0 项
      await updateRecordingDraftExclusions(
        handle.db,
        draftId,
        {
          expectedRevision: 1,
          exclusions: [{ itemId: firstFactId, reason: 'manual_discard' }],
        },
        actor(),
      )

      // 回填冲突：预期版本不匹配
      await expect(
        createScenarioFromRecordingHandoff(
          handle.db,
          draftId,
          {
            name: `回填场景-${newId()}`,
            expectedRevision: 1, // 当前应为 2
          },
          actor(),
        ),
      ).rejects.toMatchObject({ code: 'RECORDING_DRAFT_REVISION_MISMATCH' })

      // 正确回填
      const handoffName = `回填场景-${newId()}`
      const result = await createScenarioFromRecordingHandoff(
        handle.db,
        draftId,
        {
          name: handoffName,
          expectedRevision: 2,
        },
        actor(),
      )

      expect(result.scenario).toBeDefined()
      expect(result.scenario.name).toBe(handoffName)
      expect(result.scenario.latestVersionNo).toBe(1)
      expect(result.scenario.draftDirty).toBe(false)
      expect(result.scenario.draft).toBeDefined()
      expect(result.scenario.draft?.revision).toBe(2)
      expect(result.scenario.published?.authoringDocument).toBeDefined()

      // 回执校验
      expect(result.receipt).toBeDefined()
      expect(result.receipt.scenarioId).toBe(result.scenario.id)
      expect(result.receipt.recordingDraftId).toBe(draftId)
      expect(result.receipt.baseRevision).toBe(1)
      expect(result.receipt.newRevision).toBe(2)

      // sourceMap 中被排除项为 discard，其余为 accept
      const discarded = result.receipt.sourceMap.filter((m) => m.disposition === 'discard')
      const accepted = result.receipt.sourceMap.filter((m) => m.disposition === 'accept')
      expect(discarded.length).toBeGreaterThanOrEqual(1)
      expect(discarded.some((item) => item.reason === '手动剔除')).toBe(true)
      expect(accepted.length).toBeGreaterThanOrEqual(1)

      // 从数据库读取回填的场景详情
      const loadedScenario = await getScenario(handle.db, result.scenario.id)
      expect(loadedScenario.name).toBe(handoffName)
      expect(loadedScenario.draft?.revision).toBe(2)

      // 验证回填后草稿显示已回填，且带有目标场景 ID
      const draftBeforeDelete = await getRecordingDraft(handle.db, draftId, actorId)
      expect(draftBeforeDelete.imported).toBe(true)
      expect(draftBeforeDelete.importedScenarioId).toBe(result.scenario.id)

      // 删除回填生成的场景
      await deleteScenario(handle.db, result.scenario.id, actor())

      // 验证场景被软删除后，草稿的回填状态自动解除，避免死链与错误按钮状态
      const draftAfterDelete = await getRecordingDraft(handle.db, draftId, actorId)
      expect(draftAfterDelete.imported).toBe(false)
      expect(draftAfterDelete.importedScenarioId).toBeUndefined()

      const list = await listRecordingDrafts(handle.db, actorId)
      const draftInList = list.items.find((i) => i.id === draftId)
      expect(draftInList?.imported).toBe(false)
      expect(draftInList?.importedScenarioId).toBeUndefined()

      const importedList = await listRecordingDrafts(handle.db, actorId, { imported: true })
      expect(importedList.items.some((i) => i.id === draftId)).toBe(false)

      const unimportedList = await listRecordingDrafts(handle.db, actorId, { imported: false })
      expect(unimportedList.items.some((i) => i.id === draftId)).toBe(true)
    })
  },
)
