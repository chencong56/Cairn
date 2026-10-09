import { Inject, Injectable } from '@nestjs/common'
import {
  authorizeTargetRequest,
  readScenarioDurationAnalysis,
  readScenarioNodeChildren,
  readScenarioNodeHistory,
  readTargetDurationAnalysis,
  type DbHandle,
} from '@cairn/db'
import type {
  DurationAnalysisQueryParsed,
  NodeDurationChildren,
  NodeDurationChildrenQueryParsed,
  NodeDurationHistory,
  NodeDurationHistoryQueryParsed,
  ScenarioDurationAnalysis,
  TargetDurationAnalysis,
  TargetDurationAnalysisQueryParsed,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'

/** 耗时分析只读报表：按当前账号可见的目标系统收窄（target:read 与 run:read）。 */
@Injectable()
export class DurationAnalysisService {
  constructor(@Inject(DB_HANDLE) private readonly db: DbHandle) {}

  async target(targetId: string, query: TargetDurationAnalysisQueryParsed, actorId: string): Promise<TargetDurationAnalysis> {
    try {
      await authorizeTargetRequest(this.db, actorId, { targetId, ...(query.suiteId ? { suiteId: query.suiteId } : {}), permissions: ['run:read'] })
      return await readTargetDurationAnalysis(this.db, targetId, query)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async scenario(scenarioId: string, query: DurationAnalysisQueryParsed, actorId: string): Promise<ScenarioDurationAnalysis> {
    try {
      await authorizeTargetRequest(this.db, actorId, { scenarioId, permissions: ['run:read'] })
      return await readScenarioDurationAnalysis(this.db, scenarioId, query)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async node(scenarioId: string, query: NodeDurationHistoryQueryParsed, actorId: string): Promise<NodeDurationHistory> {
    try {
      await authorizeTargetRequest(this.db, actorId, { scenarioId, permissions: ['run:read'] })
      return await readScenarioNodeHistory(this.db, scenarioId, query)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async children(scenarioId: string, query: NodeDurationChildrenQueryParsed, actorId: string): Promise<NodeDurationChildren> {
    try {
      await authorizeTargetRequest(this.db, actorId, { scenarioId, permissions: ['run:read'] })
      return await readScenarioNodeChildren(this.db, scenarioId, query)
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
