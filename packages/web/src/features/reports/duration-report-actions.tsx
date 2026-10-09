import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import type { ReportDto } from '@cairn/shared'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Button } from '@/components/ui/button'
import { useCan } from '@/hooks/use-permissions'
import { ApiRequestError } from '@/lib/api-client'
import { createReportRevision, deleteReport, exportReport, previewDeleteReport } from '@/lib/reports-api'
import { ExportJobCard, ReportDelivery } from './delivery'

function newIdempotencyKey() {
  return `report-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** 周期耗时报告的操作：导出 HTML、重新取数生成新修订、删除；修订与历史文件沿用通用交付区。 */
export function DurationReportActions({ report }: { report: ReportDto }) {
  const canExport = useCan('report:export')
  const canDelete = useCan('report:delete')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const revision = report.currentRevision

  async function run(work: () => Promise<void>, failure: string) {
    setBusy(true)
    try {
      await work()
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : failure)
    } finally {
      setBusy(false)
    }
  }

  const exportHtml = () =>
    run(async () => {
      if (!revision) return
      const job = await exportReport(report.id, revision.id, { formats: ['html'], idempotencyKey: newIdempotencyKey() })
      queryClient.setQueryData(['export-job', job.id], job)
      setJobId(job.id)
      toast.success('已排队导出 HTML 报告')
    }, '导出失败')

  const regenerate = () =>
    run(async () => {
      await createReportRevision(report.id, { reason: '重新取数', idempotencyKey: newIdempotencyKey() })
      await queryClient.invalidateQueries({ queryKey: ['report', report.id] })
      await queryClient.invalidateQueries({ queryKey: ['report-revisions', report.id] })
      toast.success('已按最新数据生成新修订')
    }, '生成新修订失败')

  return (
    <section className='flex flex-col gap-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <div className='flex flex-wrap items-center gap-2'>
        {canExport ? (
          <>
            <Button disabled={busy || !revision?.sealedAt} onClick={() => void exportHtml()}>
              导出 HTML
            </Button>
            <Button variant='outline' disabled={busy} onClick={() => void regenerate()}>
              重新取数生成新修订
            </Button>
          </>
        ) : null}
        {canDelete ? (
          <Button variant='outline' className='text-status-error' disabled={busy} onClick={() => setDeleting(true)}>
            删除报告
          </Button>
        ) : null}
        <span className='text-label text-muted-foreground'>报告是生成时的快照；重新取数会生成新修订，旧修订保留。</span>
      </div>
      {jobId ? <ExportJobCard id={jobId} /> : null}
      <ReportDelivery report={report} activeJobId={jobId} />
      {deleting ? (
        <ResourceDeleteDialog
          open={deleting}
          onOpenChange={setDeleting}
          resourceType='report'
          resourceId={report.id}
          resourceName={revision?.title ?? '报告'}
          previewFn={() => previewDeleteReport(report.id)}
          deleteFn={async () => {
            await deleteReport(report.id)
          }}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: ['reports'] })
            void navigate({ to: '/duration-analysis', search: { targetId: report.targetId } })
          }}
        />
      ) : null}
    </section>
  )
}
