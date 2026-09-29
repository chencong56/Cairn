#!/usr/bin/env node
/**
 * 识途分层验证 CLI (pnpm verify:changed)
 *
 * 依据改动影响半径智能选择 L1 局部验证或 L2 全量升级，并在命中对应领域时提示 L3 专项命令。
 * 用法:
 *   pnpm verify:changed
 *   pnpm verify:changed --dry-run
 *   pnpm verify:changed --files packages/web/src/App.tsx,packages/web/package.json
 */

import { execSync, spawnSync } from 'node:child_process'
import { analyzeVerificationScope, evaluateRemoteFreshness } from './lib/verify-changed.mjs'

function parseArgs() {
  const args = process.argv.slice(2)
  let dryRun = false
  let forceFull = false
  let files = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--full') {
      forceFull = true
    } else if (arg === '--files' && i + 1 < args.length) {
      files = args[++i].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    } else if (arg.startsWith('--files=')) {
      files = arg.slice('--files='.length).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    }
  }

  return { dryRun, forceFull, files }
}

function getChangedFilesFromGit() {
  const fileSet = new Set()

  // 1. 获取 merge-base 基准
  let baseCommit = ''
  try {
    baseCommit = execSync('git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo "HEAD~1"', {
      encoding: 'utf8',
    }).trim()
  } catch {
    baseCommit = 'HEAD~1'
  }

  // 2. 相对基准已提交的变更
  try {
    const diffOut = execSync(`git diff --name-only ${baseCommit} HEAD`, { encoding: 'utf8' })
    for (const line of diffOut.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) fileSet.add(trimmed)
    }
  } catch {
    // 忽略异常，降级至工作区状态
  }

  // 3. 工作区未提交与未跟踪变更
  try {
    const statusOut = execSync('git status --porcelain', { encoding: 'utf8' })
    for (const line of statusOut.split('\n')) {
      if (!line || line.length < 4) continue
      // porcelain 格式恒定为前 2 字符状态 + 1 空格 + 路径（或 old -> new）
      const rawPath = line.slice(3).trim()
      const parts = rawPath.split(' -> ')
      const filePath = parts[parts.length - 1]?.trim()
      if (filePath) fileSet.add(filePath)
    }
  } catch {
    // 忽略
  }

  return [...fileSet].sort()
}

function checkOriginMainFreshness() {
  try {
    const timestampStr = execSync('git log -1 --format=%ct origin/main 2>/dev/null', { encoding: 'utf8' }).trim()
    const ts = parseInt(timestampStr, 10)
    return evaluateRemoteFreshness(ts)
  } catch {
    return { isStale: false, ageHours: 0 }
  }
}

function main() {
  const { dryRun, forceFull, files: explicitFiles } = parseArgs()
  const freshness = checkOriginMainFreshness()
  const files = explicitFiles ?? getChangedFilesFromGit()

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🔍 识途分层验证 (Layered Verification: L1 / L2 / L3)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  if (freshness.isStale && !explicitFiles) {
    console.log(`⚠️  [基线时效提示] 本地 origin/main 距今已有 ${freshness.ageHours} 小时未拉取更新。`)
    console.log(`   计算出的变更可能包含历史已合入改动并升级全量。建议先运行: git fetch origin main，或使用 --files 指定具体改动文件。\n`)
  }
  console.log(`变更文件 (${files.length} 项):`)
  if (files.length <= 15) {
    for (const f of files) console.log(`  - ${f}`)
  } else {
    for (const f of files.slice(0, 12)) console.log(`  - ${f}`)
    console.log(`  ... 另有 ${files.length - 12} 项文件`)
  }
  console.log('─────────────────────────────────────────────────────────────────')

  const analysis = analyzeVerificationScope(files)
  if (forceFull) {
    analysis.isFull = true
    analysis.reasons.push('用户显式指定了 --full 强制全量')
  }

  if (analysis.isDocsOnly) {
    console.log('✅ 判定结论: 仅涉及文档或辅助元数据改动，无需执行包级验证。')
    if (analysis.l3Suggestions.length > 0) {
      console.log(`💡 提示命令: ${analysis.l3Suggestions.join(' && ')}`)
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    process.exit(0)
  }

  if (analysis.isFull) {
    console.log('🚨 判定结论: 升级为 L2 全量验证 (Full Verification)')
    console.log('升级原因:')
    for (const r of analysis.reasons) console.log(`  • ${r}`)
  } else {
    console.log('⚡ 判定结论: 执行 L1 局部受影响包验证 (Targeted Verification)')
    console.log(`直接涉及包: [${analysis.changedPackages.join(', ') || '无'}]`)
    console.log(`验证目标包 (含下游依赖): [${analysis.targetPackages.join(', ')}]`)
    for (const note of analysis.gateNotes ?? []) console.log(`  ℹ️  ${note}`)
  }

  if (analysis.l3Suggestions.length > 0) {
    console.log('─────────────────────────────────────────────────────────────────')
    console.log('📌 L3 专项领域提示 (改动命中核心垂直切片，交付前建议按需执行):')
    for (const sug of analysis.l3Suggestions) console.log(`  👉 ${sug}`)
  }

  const commandToRun = analysis.isFull ? analysis.fullCommand : analysis.turboCommand
  console.log('─────────────────────────────────────────────────────────────────')
  console.log(`🚀 执行命令: ${commandToRun}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  if (dryRun) {
    console.log('[DRY-RUN] 仅试跑决策，不实际执行命令。')
    process.exit(0)
  }

  const result = spawnSync(commandToRun, {
    stdio: 'inherit',
    shell: true,
  })

  process.exit(result.status ?? 0)
}

main()
