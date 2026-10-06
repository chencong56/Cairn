import { Inject, Injectable } from '@nestjs/common'
import { loadTargetForExecution, notFound, type DbHandle } from '@cairn/db'
import {
  normalizeAuthoringObservation,
  type AuthoringObservationSubmit,
  type TargetObservation,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'

@Injectable()
export class AuthoringService {
  constructor(@Inject(DB_HANDLE) private readonly db: DbHandle) {}

  async normalizeObservation(body: AuthoringObservationSubmit): Promise<TargetObservation> {
    try {
      const target = await loadTargetForExecution(this.db, body.targetId)
      if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
      return normalizeAuthoringObservation(body)
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
