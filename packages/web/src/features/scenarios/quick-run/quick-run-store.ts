import { create } from 'zustand'

/**
 * 本标签页从场景列表发起的运行。模块级状态：在应用内切换页面不丢，刷新后清空
 * （刷新后从卡片上的运行状态进入观测抽屉）。任务条只是它的一个视图。
 */
export type QuickRunEntry = {
  runId: string
  scenarioId: string
  scenarioName: string
  versionNo: number | null
  startedAt: number
  /** 由任务条按观测结果回写；未知时视为仍在进行。 */
  status?: string
}

/** 同时实时跟踪的运行上限：每个运行一条 SSE，避免占满浏览器的同源连接。 */
export const MAX_LIVE_RUNS = 3

type QuickRunState = {
  runs: QuickRunEntry[]
  add: (entry: QuickRunEntry) => void
  remove: (runId: string) => void
  setStatus: (runId: string, status: string) => void
}

export const useQuickRunStore = create<QuickRunState>((set) => ({
  runs: [],
  add: (entry) => set((state) => ({ runs: [...state.runs.filter((run) => run.runId !== entry.runId), entry] })),
  remove: (runId) => set((state) => ({ runs: state.runs.filter((run) => run.runId !== runId) })),
  setStatus: (runId, status) =>
    set((state) => ({
      runs: state.runs.map((run) => (run.runId === runId && run.status !== status ? { ...run, status } : run)),
    })),
}))
