import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import type { EvidenceMetadata, RunVideoChapterModel } from '@cairn/shared'
import { RunVideoPlayer } from '../run-video-player'

const mockEvidence: EvidenceMetadata = {
  schemaVersion: 1,
  id: 'ev-vid-1',
  runId: 'run-1',
  type: 'video',
  status: 'available',
  createdAt: '2026-09-21T02:00:20.000Z',
  contentType: 'video/webm',
  byteSize: 4096,
}

const mockChapterModel: RunVideoChapterModel = {
  clock: {
    originMs: 1726884000000,
    spanMs: 20000,
    mediaMs: 20000,
    alignment: 'exact',
  },
  chapters: [
    {
      stepRunId: 'sr-1',
      stepId: 's-1',
      ordinal: 0,
      name: '打开页面',
      type: 'navigate',
      status: 'SUCCEEDED',
      fromMs: 0,
      toMs: 5000,
      durationMs: 5000,
      clipped: false,
      attemptCount: 1,
    },
    {
      stepRunId: 'sr-2',
      stepId: 's-2',
      ordinal: 1,
      name: '点击登录',
      type: 'click',
      status: 'FAILED',
      fromMs: 6000,
      toMs: 12000,
      durationMs: 6000,
      clipped: false,
      attemptCount: 2,
    },
    {
      stepRunId: 'sr-3',
      stepId: 's-3',
      ordinal: 2,
      name: '确认结果',
      type: 'assert',
      status: 'SUCCEEDED',
      fromMs: 14000,
      toMs: 19000,
      durationMs: 5000,
      clipped: false,
      attemptCount: 1,
    },
  ],
  pins: [
    {
      attemptId: 'att-fail-1',
      stepRunId: 'sr-2',
      attemptNo: 1,
      atMs: 9000,
    },
  ],
  gaps: [
    { fromMs: 2000, toMs: 4000, reason: 'rate_limit', kind: 'still' },
    { fromMs: 12000, toMs: 13000, reason: 'capture_failed', kind: 'blank' },
  ],
  offAxisStepRunIds: [],
}

vi.mock('@/lib/runs-api', () => ({
  fetchEvidenceContent: vi.fn(async () => ({
    blob: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' }),
    contentType: 'video/webm',
  })),
}))

describe('RunVideoPlayer', () => {
  it('VT01 / VT11: 渲染自定义播放器控件，包含 role="slider"、时间码、全屏与下载', async () => {
    const { getByRole, getByText } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
      />,
    )

    await expect.element(getByRole('button', { name: '播放' })).toBeInTheDocument()
    await expect.element(getByRole('slider', { name: '录像进度' })).toBeInTheDocument()
    await expect.element(getByText('0:00 / 0:20')).toBeInTheDocument()
    await expect.element(getByRole('button', { name: '全屏' })).toBeInTheDocument()
    await expect.element(getByRole('button', { name: '下载录像' })).toBeInTheDocument()
    await expect.element(getByText(/正在看：1\. 打开页面/)).toBeInTheDocument()
  })

  it('VT04: 渲染失败钉并支持点击跳到失败现场时刻', async () => {
    const onSeek = vi.fn()
    const { getByRole } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
        onSeek={onSeek}
      />,
    )

    const pinBtn = getByRole('button', { name: '第 1 次尝试失败现场' })
    await expect.element(pinBtn).toBeInTheDocument()
    await pinBtn.click()
    expect(onSeek).toHaveBeenCalledWith(9000)
  })

  it('VT02 / VT11: 键盘快捷键与进度条快进', async () => {
    const onSeek = vi.fn()
    const { getByRole } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
        onSeek={onSeek}
      />,
    )

    const slider = getByRole('slider', { name: '录像进度' })
    await slider.click()
    expect(onSeek).toHaveBeenCalled()
  })

  it('VT03: 轴外步骤显示“不在录像里”', async () => {
    const { getByText } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
        offAxisSelectedStep={{ ordinal: 5, name: '轴外未录制步骤' }}
      />,
    )
    await expect.element(getByText('正在看：6. 轴外未录制步骤 · 不在录像里')).toBeInTheDocument()
  })

  it('VT06: 历史录像无 timing 提示', async () => {
    const { getByText } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={{
          clock: null,
          chapters: [],
          pins: [],
          gaps: [],
          offAxisStepRunIds: [],
        }}
      />,
    )
    await expect.element(getByText('历史录像，步骤对不上时间')).toBeInTheDocument()
  })

  it('上一步 / 下一步章节导航', async () => {
    const onSeek = vi.fn()
    const { getByRole } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
        onSeek={onSeek}
      />,
    )

    const nextBtn = getByRole('button', { name: '下一步' })
    await nextBtn.click()
    expect(onSeek).toHaveBeenCalledWith(6000) // 下一步跳到 sr-2 的 fromMs
  })

  it('渲染步骤胶囊轨，支持点击步骤胶囊跳转与选中', async () => {
    const onSeek = vi.fn()
    const onSelectStep = vi.fn()
    const { getByRole, getByText } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
        onSeek={onSeek}
        onSelectStep={onSelectStep}
      />,
    )

    // 显示位置指示
    await expect.element(getByText('1 / 3')).toBeInTheDocument()

    // 检查胶囊渲染并点击第 2 步（失败步骤）
    const step2Tab = getByRole('tab', { name: /2\. 点击登录/ })
    await expect.element(step2Tab).toBeInTheDocument()
    await step2Tab.click()

    expect(onSeek).toHaveBeenCalledWith(6000)
    expect(onSelectStep).toHaveBeenCalledWith('sr-2')
  })

  it('当步骤数量超过 8 步时，依然正常渲染步骤胶囊轨（不被隐藏）', async () => {
    const chapters = Array.from({ length: 12 }, (_, i) => ({
      stepRunId: `sr-${i + 1}`,
      stepId: `s-${i + 1}`,
      ordinal: i,
      name: `测试步骤 ${i + 1}`,
      type: 'click',
      status: 'SUCCEEDED' as const,
      fromMs: i * 2000,
      toMs: (i + 1) * 2000,
      durationMs: 2000,
      clipped: false,
      attemptCount: 1,
    }))

    const multiStepModel: RunVideoChapterModel = {
      clock: {
        originMs: 1726884000000,
        spanMs: 24000,
        mediaMs: 24000,
        alignment: 'exact',
      },
      chapters,
      pins: [],
      gaps: [],
      offAxisStepRunIds: [],
    }

    const { getByRole, getByText } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={multiStepModel}
      />,
    )

    await expect.element(getByText('1 / 12')).toBeInTheDocument()
    // 第 1 步和第 12 步都在文档内渲染
    await expect.element(getByRole('tab', { name: '1. 测试步骤 1', exact: true })).toBeInTheDocument()
    await expect.element(getByRole('tab', { name: '12. 测试步骤 12', exact: true })).toBeInTheDocument()
  })

  it('浏览器仿真：7 步骤实际弹窗宽度下渲染整齐、单行不挤压并截取快照', async () => {
    await page.viewport(1280, 800)
    const sevenSteps: RunVideoChapterModel = {
      clock: {
        originMs: 1726884000000,
        spanMs: 31000,
        mediaMs: 31000,
        alignment: 'exact',
      },
      chapters: [
        { stepRunId: 'sr-1', stepId: 's-1', ordinal: 0, name: '打开页面', type: 'navigate', status: 'SUCCEEDED', fromMs: 0, toMs: 9500, durationMs: 9500, clipped: false, attemptCount: 1 },
        { stepRunId: 'sr-2', stepId: 's-2', ordinal: 1, name: '进入分组管理', type: 'click', status: 'SUCCEEDED', fromMs: 9500, toMs: 13000, durationMs: 3500, clipped: false, attemptCount: 1 },
        { stepRunId: 'sr-3', stepId: 's-3', ordinal: 2, name: '管理端导航存在', type: 'assert', status: 'SUCCEEDED', fromMs: 13000, toMs: 16000, durationMs: 3000, clipped: false, attemptCount: 1 },
        { stepRunId: 'sr-4', stepId: 's-4', ordinal: 3, name: '分组标题存在', type: 'assert', status: 'SUCCEEDED', fromMs: 16000, toMs: 19000, durationMs: 3000, clipped: false, attemptCount: 1 },
        { stepRunId: 'sr-5', stepId: 's-5', ordinal: 4, name: '进入管理员总览', type: 'click', status: 'SUCCEEDED', fromMs: 19000, toMs: 23000, durationMs: 4000, clipped: false, attemptCount: 1 },
        { stepRunId: 'sr-6', stepId: 's-6', ordinal: 5, name: '管理员总览标题存在', type: 'assert', status: 'SUCCEEDED', fromMs: 23000, toMs: 27000, durationMs: 4000, clipped: false, attemptCount: 1 },
        { stepRunId: 'sr-7', stepId: 's-7', ordinal: 6, name: '两个动作模块完成后返回管理员总览', type: 'click', status: 'SUCCEEDED', fromMs: 27000, toMs: 31000, durationMs: 4000, clipped: false, attemptCount: 1 },
      ],
      pins: [],
      gaps: [{ fromMs: 0, toMs: 9500, reason: 'rate_limit', kind: 'still' }],
      offAxisStepRunIds: [],
    }

    const { getByRole, getByText } = await render(
      <div className='w-[600px] bg-card p-4 rounded-lg border border-border-card space-y-3'>
        <h2 className='text-section font-semibold'>本次录像</h2>
        <RunVideoPlayer
          runId='run-sim-1'
          evidence={mockEvidence}
          chapterModel={sevenSteps}
        />
      </div>,
    )

    // 验证文字与指示
    await expect.element(getByText(/正在看：1\. 打开页面 · 9\.5 秒 · 成功 · 画面无变化/)).toBeVisible()
    await expect.element(getByText('1 / 7')).toBeVisible()

    // 截取 7 步仿真截图
    await page.screenshot({
      path: 'src/features/runs/__tests__/__screenshots__/trial-video-simulation-7steps.png',
    })

    // 点击下一步，验证切到第 2 步并高亮
    const nextBtn = getByRole('button', { name: '下一步' })
    await nextBtn.click()
    await expect.element(getByText('2 / 7')).toBeVisible()

    // 截取第 2 步高亮切换截图
    await page.screenshot({
      path: 'src/features/runs/__tests__/__screenshots__/trial-video-simulation-step2-active.png',
    })
  })

  it('浏览器仿真：15 步骤超量场景下胶囊轨平滑滚动不折行并截取快照', async () => {
    await page.viewport(1280, 800)
    const fifteenStepsChapters = Array.from({ length: 15 }, (_, i) => ({
      stepRunId: `sr-${i + 1}`,
      stepId: `s-${i + 1}`,
      ordinal: i,
      name: i % 2 === 0 ? `常规业务步骤 ${i + 1}` : `长文本检查步骤验证系统响应 ${i + 1}`,
      type: 'click',
      status: i === 4 ? ('FAILED' as const) : i === 7 ? ('RUNNING' as const) : ('SUCCEEDED' as const),
      fromMs: i * 2000,
      toMs: (i + 1) * 2000,
      durationMs: 2000,
      clipped: false,
      attemptCount: 1,
    }))

    const fifteenStepsModel: RunVideoChapterModel = {
      clock: {
        originMs: 1726884000000,
        spanMs: 30000,
        mediaMs: 30000,
        alignment: 'exact',
      },
      chapters: fifteenStepsChapters,
      pins: [{ attemptId: 'pin-1', stepRunId: 'sr-5', attemptNo: 1, atMs: 9000 }],
      gaps: [],
      offAxisStepRunIds: [],
    }

    const { getByText } = await render(
      <div className='w-[600px] bg-card p-4 rounded-lg border border-border-card space-y-3'>
        <h2 className='text-section font-semibold'>本次录像</h2>
        <RunVideoPlayer
          runId='run-sim-15'
          evidence={mockEvidence}
          chapterModel={fifteenStepsModel}
        />
      </div>,
    )

    await expect.element(getByText('1 / 15')).toBeVisible()

    // 截取 15 步仿真截图
    await page.screenshot({
      path: 'src/features/runs/__tests__/__screenshots__/trial-video-simulation-15steps.png',
    })
  })
})
