export function matchPublishedScenarioName(name: string, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = name.toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

/** 全选 / 取消当前可见列表，保留不在当前结果里的已选。 */
export function toggleCurrentListSelection(selectedIds: string[], visibleIds: string[]): string[] {
  if (visibleIds.length === 0) return selectedIds
  const visible = new Set(visibleIds)
  const allVisibleSelected = visibleIds.every((id) => selectedIds.includes(id))
  if (allVisibleSelected) return selectedIds.filter((id) => !visible.has(id))
  const extra = visibleIds.filter((id) => !selectedIds.includes(id))
  return [...selectedIds, ...extra]
}
