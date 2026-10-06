import { eq } from 'drizzle-orm'
import {
  parseTargetResolutionPolicy,
  stepsNeedLocatorAiExecute,
  type LocatorPlan,
  type PlatformConfigDocument,
  type TargetResolutionPolicy,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'

export async function loadResolutionLayers(db: Db, targetId?: string) {
  const platform = await getOrCreatePlatformConfig(db)
  let targetPolicy: TargetResolutionPolicy | null = null
  if (targetId) {
    const { targets } = schemaFor(db)
    const [row] = await db
      .select({ resolutionPolicy: targets.resolutionPolicy })
      .from(targets)
      .where(eq(targets.id, targetId))
      .limit(1)
    targetPolicy = parseTargetResolutionPolicy(row?.resolutionPolicy)
  }
  return {
    document: platform.document,
    revision: platform.revision,
    targetPolicy,
  }
}

export function stepsNeedAiExecute(
  steps: readonly { id?: string; type: string; disabled?: boolean; policy?: { locatorPlan?: LocatorPlan } }[],
  layers: {
    document: PlatformConfigDocument
    targetPolicy?: TargetResolutionPolicy | null
  },
  scenarioPlan?: LocatorPlan,
): boolean {
  return stepsNeedLocatorAiExecute({
    steps,
    document: layers.document,
    target: layers.targetPolicy,
    scenarioPlan,
  })
}
