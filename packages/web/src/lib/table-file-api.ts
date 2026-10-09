import {
  tableFilePreviewRequestSchema,
  tableFilePreviewResponseSchema,
  type TableFilePreviewRequest,
  type TableFilePreviewResponse,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

/** 文件来源的编写期预览：最近一次运行里下载的文件，或上传的样例（服务端只在内存里解析，不保存）。 */
export function previewTableFile(scenarioId: string, body: TableFilePreviewRequest): Promise<TableFilePreviewResponse> {
  return apiFetch(`/api/scenarios/${scenarioId}/table-file/preview`, tableFilePreviewResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tableFilePreviewRequestSchema.parse(body)),
  })
}

/** 浏览器里把文件读成 base64（上传样例用）。 */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      resolve(text.slice(text.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}
