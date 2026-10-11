/**
 * 从图表引导卡切到“接口返回的数据”后，新面板一挂载就打开“选择接口”对话框。
 * 只在同一次界面操作里传递（不持久化）：对话框关上即清除。
 */
const pending = new Set<string>()

export function requestNetworkPicker(stepId: string): void {
  pending.add(stepId)
}

export function hasNetworkPickerRequest(stepId: string): boolean {
  return pending.has(stepId)
}

export function clearNetworkPickerRequest(stepId: string): void {
  pending.delete(stepId)
}
