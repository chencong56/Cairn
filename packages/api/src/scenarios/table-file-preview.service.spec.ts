import { describe, expect, it, vi, beforeEach } from 'vitest'
import { HttpException } from '@nestjs/common'
import { RUN_FILE_HANDLE_KIND, TABLE_FILE_PROTOCOL, tableFilePlanSchema, type TableFilePreviewRequest } from '@cairn/shared'
import { isTableFilePreviewPath } from '../config/body-parsers'
import { TableFilePreviewService } from './table-file-preview.service'

const db = vi.hoisted(() => ({
  getScenario: vi.fn(),
  authorizeTargetRequest: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
}))
vi.mock('@cairn/db', async (orig) => ({ ...(await orig<typeof import('@cairn/db')>()), ...db }))

const SCENARIO = '00000000-0000-4000-8000-0000000000a1'
const DOWNLOAD_STEP = '00000000-0000-4000-8000-0000000000d1'
const RUN_OK = '00000000-0000-4000-8000-0000000000f2'
const RUN_FAILED = '00000000-0000-4000-8000-0000000000f1'

const csv = (rows: number) => {
  const lines = ['站点清单导出', '', '编号,站点名称,数量']
  for (let i = 0; i < rows; i++) lines.push(`${1000 + i},站点${i + 1},${(i % 7) + 1}`)
  return Buffer.from(lines.join('\n'), 'utf8')
}

const handle = (runId: string, objectKey: string) => ({
  kind: RUN_FILE_HANDLE_KIND,
  scope: 'run',
  runId,
  objectKey,
  name: '站点清单.csv',
  mimeType: 'text/csv',
  byteSize: 100,
  digest: `sha256:${'0'.repeat(64)}`,
  createdAt: '2026-10-09T06:00:00.000Z',
})

const body = (extra: Partial<TableFilePreviewRequest> = {}): TableFilePreviewRequest => ({
  fromKey: 'exportFile',
  downloadStepId: DOWNLOAD_STEP,
  source: { kind: 'latest_run' },
  ...extra,
})

describe('文件来源的编写期预览', () => {
  const objects = new Map<string, Buffer>()
  const store = { get: vi.fn(async (key: string) => ({ body: new Uint8Array(objects.get(key) as Buffer), head: { key, byteSize: 0, digest: '' } })) }
  const service = new TableFilePreviewService({} as never, store as never)

  beforeEach(() => {
    Object.values(db).forEach((fn) => fn.mockReset())
    db.getScenario.mockResolvedValue({ id: SCENARIO, targetId: 't' })
    db.authorizeTargetRequest.mockResolvedValue(undefined)
  })

  it('上传的样例：跳过标题行找到表头，给出建议计划与预览，不读运行', async () => {
    const r = await service.preview(SCENARIO, body({ source: { kind: 'upload', name: 'a.csv', base64: csv(3).toString('base64') } }), 'actor')
    expect(r.source.kind).toBe('upload')
    expect(r.headerRow).toBe(3)
    expect(r.plan.columns.map((c) => c.name)).toEqual(['编号', '站点名称', '数量'])
    expect(r.sample.rows).toHaveLength(3)
    expect(db.listRuns).not.toHaveBeenCalled()
  })

  it('最近的运行：跳过下载失败的那次，取最近一次成功产出的文件', async () => {
    objects.set(`v1/runs/${RUN_OK}/obj`, csv(4))
    db.listRuns.mockResolvedValue({ items: [{ id: RUN_FAILED }, { id: RUN_OK }] })
    db.getRun.mockImplementation(async (_db: unknown, id: string) =>
      id === RUN_FAILED
        ? { id, stepRuns: [{ stepId: DOWNLOAD_STEP, attempts: [{ status: 'FAILED', output: null }] }] }
        : { id, stepRuns: [{ stepId: DOWNLOAD_STEP, attempts: [{ status: 'SUCCEEDED', output: handle(RUN_OK, `v1/runs/${RUN_OK}/obj`) }] }] },
    )
    const r = await service.preview(SCENARIO, body(), 'actor')
    expect(r.source).toMatchObject({ kind: 'latest_run', runId: RUN_OK })
    expect(r.file.name).toBe('站点清单.csv')
    expect(r.sample.rows).toHaveLength(4)
  })

  it('最近的运行里没有这个文件：404，提示先运行到下载步骤或上传样例', async () => {
    db.listRuns.mockResolvedValue({ items: [] })
    const err = await service.preview(SCENARIO, body(), 'actor').catch((e) => e)
    expect(err).toBeInstanceOf(HttpException)
    expect((err as HttpException).getStatus()).toBe(404)
    expect(JSON.stringify((err as HttpException).getResponse())).toContain('TABLE_FILE_NO_RUN_FILE')
  })

  it('已有读取计划：按计划预览（列不变），预览只回前 200 行', async () => {
    const plan = tableFilePlanSchema.parse({
      protocol: TABLE_FILE_PROTOCOL,
      fromKey: 'exportFile',
      columns: [{ key: 'qty', name: '数量', valueType: 'number', numericKind: 'integer' }],
    })
    const r = await service.preview(SCENARIO, body({ plan, source: { kind: 'upload', name: 'a.csv', base64: csv(250).toString('base64') } }), 'actor')
    expect(r.plan.columns.map((c) => c.key)).toEqual(['qty'])
    expect(r.sample.rows).toHaveLength(200)
    expect(r.sample.rowCount).toBe(250)
    expect(r.sample.presentation.omitted).toBe(true)
  })

  it('不认识的文件：明确报错（409），不猜', async () => {
    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)])
    const err = await service.preview(SCENARIO, body({ source: { kind: 'upload', name: 'a.xls', base64: xls.toString('base64') } }), 'actor').catch((e) => e)
    expect((err as HttpException).getStatus()).toBe(409)
    expect(JSON.stringify((err as HttpException).getResponse())).toContain('TABLE_FILE_XLS_UNSUPPORTED')
  })

  it('请求体放宽只作用于预览这一个路径', () => {
    expect(isTableFilePreviewPath(`/api/scenarios/${SCENARIO}/table-file/preview`)).toBe(true)
    expect(isTableFilePreviewPath(`/api/scenarios/${SCENARIO}/table-file/preview/x`)).toBe(false)
    expect(isTableFilePreviewPath(`/api/scenarios/${SCENARIO}`)).toBe(false)
  })
})
