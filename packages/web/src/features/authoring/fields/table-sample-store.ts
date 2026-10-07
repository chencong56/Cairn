import { useSyncExternalStore } from 'react'
import type { TableSample } from '@cairn/shared'

/**
 * 编辑器里“读取表格”的最近一次预览，按步骤保存：数据检查要用它给出候选值、
 * 并按当前预览提示这条检查会不会通过。只在本页内存里，不进场景文档，也不替代运行时的实时读取。
 */
const samples = new Map<string, TableSample>()
const listeners = new Set<() => void>()

export function setTableSample(stepId: string, sample: TableSample | null): void {
  if (sample) samples.set(stepId, sample)
  else samples.delete(stepId)
  for (const listener of listeners) listener()
}

export function useTableSample(stepId: string): TableSample | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => samples.get(stepId) ?? null,
    () => null,
  )
}
