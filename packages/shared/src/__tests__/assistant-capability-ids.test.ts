import { describe, expect, it } from 'vitest'
import { ASSISTANT_HISTORICAL_CAPABILITY_IDS, ASSISTANT_PUBLISHED_CAPABILITY_IDS } from '../assistant.js'

describe('助手能力 id', () => {
  it('每个已发布能力都能作为轮次的历史能力 id 落库', () => {
    const historical = new Set<string>(ASSISTANT_HISTORICAL_CAPABILITY_IDS)
    expect(ASSISTANT_PUBLISHED_CAPABILITY_IDS.filter((id) => !historical.has(id))).toEqual([])
  })
})
