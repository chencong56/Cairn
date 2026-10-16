/**
 * 核对脚本用：按名称替换场景。更新已有场景的步骤要走草稿 + 发布，核对脚本不复用旧场景：
 * 删掉上一次留下的同名场景（带上删除预览给出的计数），再按当前步骤新建，保证试跑用的就是这次的步骤。
 * 已删除场景的名字不能复用，所以新场景名带上时间戳，清理时按名称前缀找旧场景。
 */
export async function replaceScenario(req, targetId, baseName, steps) {
  const listed = (await req(`/scenarios?targetId=${targetId}&search=${encodeURIComponent(baseName)}&limit=100`)).items ?? []
  for (const old of listed.filter((s) => s.name === baseName || s.name.startsWith(`${baseName}（`))) {
    const preview = await req(`/scenarios/${old.id}/delete-preview`)
    if (preview.blockers?.length) throw new Error(`旧场景「${old.name}」无法删除：${JSON.stringify(preview.blockers)}`)
    await req(`/scenarios/${old.id}/delete`, 'POST', { expectedCounts: preview.counts })
  }
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14)
  return req('/scenarios', 'POST', { targetId, name: `${baseName}（${stamp}）`, steps })
}
