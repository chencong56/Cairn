import type { PlatformConfigDocument } from '@cairn/shared'

export function cloneDocument(
  document: PlatformConfigDocument
): PlatformConfigDocument {
  const next = structuredClone(document)
  if (!next.platformAi.provider) delete next.platformAi.provider
  return next
}

export function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN')
}
