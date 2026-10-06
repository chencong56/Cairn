import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TargetAccessPolicy } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchTargetAccessPolicy,
  updateTargetAccessPolicy,
} from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectField, SelectFieldOption } from '@/components/ui/select'

export function AccessPolicyCard({ targetId }: { targetId: string }) {
  const canRead = useCan('map:read')
  const canWrite = useCan('target:write')
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [postOrigin, setPostOrigin] = useState('')
  const [postPath, setPostPath] = useState('')
  const [nonContentOrigin, setNonContentOrigin] = useState('')
  const [nonContentPath, setNonContentPath] = useState('')
  const [nonContentResourceType, setNonContentResourceType] = useState<'xhr' | 'fetch'>('xhr')
  const [nonContentEvidence, setNonContentEvidence] = useState('')

  const query = useQuery({
    queryKey: ['target', targetId, 'access-policy'],
    queryFn: () => fetchTargetAccessPolicy(targetId),
    enabled: canRead,
  })

  const mutation = useMutation({
    mutationFn: (change: {
      readOnlyRequests: TargetAccessPolicy['readOnlyRequests']
      verifiedNonContentRequests?: NonNullable<TargetAccessPolicy['verifiedNonContentRequests']>
      postReadMode?: 'explicit' | 'balanced'
    }) =>
      updateTargetAccessPolicy(targetId, {
        expectedRevision: query.data?.revision ?? 0,
        idempotencyKey: `access:${Date.now()}`,
        ...change,
        verifiedNonContentRequests: change.verifiedNonContentRequests
          ?? query.data?.policy?.verifiedNonContentRequests ?? [],
        postReadMode: change.postReadMode ?? query.data?.policy?.postReadMode ?? 'explicit',
        reason: reason.trim() || (change.postReadMode === 'balanced'
          ? '启用地图采集 POST 平衡模式'
          : change.postReadMode === 'explicit' ? '恢复地图采集 POST 显式规则模式' : '更新地图采集只读规则'),
      }),
    onSuccess: () => {
      toast.success('已更新地图采集只读规则')
      setReason('')
      setPostOrigin('')
      setPostPath('')
      setNonContentOrigin('')
      setNonContentPath('')
      setNonContentEvidence('')
      void queryClient.invalidateQueries({
        queryKey: ['target', targetId, 'access-policy'],
      })
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '更新地图采集只读规则失败'
      )
    },
  })

  if (!canRead) return null
  const current = query.data
  const readOnlyRequests = current?.policy?.readOnlyRequests ?? []
  const postReadMode = current?.policy?.postReadMode ?? 'explicit'
  const verifiedNonContentRequests = current?.policy?.verifiedNonContentRequests ?? []
  const validNonContentOrigin = (() => {
    try {
      const url = new URL(nonContentOrigin.trim())
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
        && url.pathname === '/' && !url.search && !url.hash
    } catch { return false }
  })()
  const validNonContentPath = nonContentPath.startsWith('/') && nonContentPath.length <= 512
    && !/[?#*]/.test(nonContentPath)

  return (
    <Card className='min-w-0'>
      <CardHeader className='flex flex-row items-start justify-between gap-3'>
        <div>
          <CardTitle className='text-section font-semibold'>地图采集只读规则</CardTitle>
          <p className='mt-1 text-label text-muted-foreground'>
            仅作用于地图采集：采集只在目标站点内读取，并默认阻断写请求。不影响场景运行、调试与录制。
          </p>
        </div>
        {current ? (
          <span className='rounded bg-surface-subtle px-2 py-0.5 font-mono text-label text-muted-foreground'>
            {current.seeded
              ? '默认 (未发布)'
              : `修订 Rev.${current.revision}`}
          </span>
        ) : null}
      </CardHeader>
      <CardContent className='space-y-5'>
        {query.isPending ? (
          <p className='text-label text-muted-foreground'>授权加载中…</p>
        ) : query.isError ? (
          <p className='text-label text-muted-foreground'>
            暂时无法读取地图采集只读规则。
          </p>
        ) : current ? (
          <>
            <div className='space-y-3 border-t border-border-divider pt-5'>
              <div>
                <h3 className='text-small font-semibold text-text-primary'>地图采集中的 POST 查询</h3>
                <p className='mt-1 text-label text-muted-foreground'>
                  当前为{postReadMode === 'balanced' ? '平衡模式' : '显式规则模式'}。平衡模式仅在地图采集时，对目标站点内的 XHR/fetch POST 按请求意图作有限推断；放行记录会单独审计，推断不等于已证明只读。无法归类的请求仍会阻断并使页面部分完成。
                </p>
              </div>
              {canWrite ? <Button variant='outline' disabled={mutation.isPending} onClick={() => mutation.mutate({
                readOnlyRequests, postReadMode: postReadMode === 'balanced' ? 'explicit' : 'balanced',
              })}>{postReadMode === 'balanced' ? '恢复显式规则模式' : '启用平衡模式'}</Button> : null}
            </div>
            <div className='space-y-3 border-t border-border-divider pt-5'>
              <div>
                <h3 className='text-small font-semibold text-text-primary'>只读 POST 请求</h3>
                <p className='mt-1 text-label text-muted-foreground'>
                  为已确认的查询端点配置精确路径；优先于平衡模式判定。
                </p>
              </div>
              {readOnlyRequests.length ? (
                <ul className='space-y-2'>
                  {readOnlyRequests.map((item, index) => (
                    <li key={`${item.origin}:${item.pathPattern}:${index}`} className='flex items-center justify-between gap-2 rounded-md border border-border-divider bg-surface-subtle p-3'>
                      <span className='min-w-0 break-all font-mono text-small'>POST {item.origin}{item.pathPattern}</span>
                      {canWrite ? <Button variant='outline' size='sm' disabled={mutation.isPending} onClick={() => mutation.mutate({ readOnlyRequests: readOnlyRequests.filter((_, position) => position !== index) })}>移除</Button> : null}
                    </li>
                  ))}
                </ul>
              ) : <p className='text-label text-muted-foreground'>尚未配置；默认阻断非 GraphQL POST。</p>}
              {canWrite ? (
                <div className='grid gap-3 rounded-lg border border-border-card p-4 sm:grid-cols-2'>
                  <div className='space-y-1.5'><Label htmlFor='readonly-post-origin'>来源站点</Label><Input id='readonly-post-origin' value={postOrigin} onChange={event => setPostOrigin(event.target.value)} placeholder='https://shop.example' /></div>
                  <div className='space-y-1.5'><Label htmlFor='readonly-post-path'>精确路径</Label><Input id='readonly-post-path' value={postPath} onChange={event => setPostPath(event.target.value)} placeholder='/api/list' /></div>
                  <div className='sm:col-span-2 flex justify-end'>
                    <Button variant='outline' disabled={mutation.isPending || !postOrigin.trim() || !postPath.startsWith('/')} onClick={() => mutation.mutate({ readOnlyRequests: [...readOnlyRequests, { method: 'POST', origin: postOrigin.trim(), pathPattern: postPath.trim() }] })}>添加只读规则</Button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className='space-y-3 border-t border-border-divider pt-5'>
              <div>
                <h3 className='text-small font-semibold text-text-primary'>已核实的非页面数据请求</h3>
                <p className='mt-1 text-label text-muted-foreground'>
                  请求仍会被拦截并记录。仅对已核实不参与页面内容的 POST，按来源、精确路径和 XHR/fetch 类型排除完整性影响；未匹配请求仍使页面标记为部分完成。
                </p>
              </div>
              {verifiedNonContentRequests.length ? (
                <ul className='space-y-2'>
                  {verifiedNonContentRequests.map((item, index) => (
                    <li key={`${item.origin}:${item.pathPattern}:${item.resourceType}:${index}`} className='flex flex-wrap items-start justify-between gap-2 rounded-md border border-border-divider bg-surface-subtle p-3'>
                      <div className='min-w-0 space-y-1'>
                        <div className='break-all font-mono text-small'>POST · {item.resourceType.toUpperCase()} · {item.origin}{item.pathPattern}</div>
                        <p className='text-label text-muted-foreground'>{item.evidence}</p>
                      </div>
                      {canWrite ? <Button variant='outline' size='sm' disabled={mutation.isPending} onClick={() => mutation.mutate({ readOnlyRequests, verifiedNonContentRequests: verifiedNonContentRequests.filter((_, position) => position !== index) })}>移除</Button> : null}
                    </li>
                  ))}
                </ul>
              ) : <p className='text-label text-muted-foreground'>尚无核实规则；未知 XHR/fetch 拦截均影响完整性。</p>}
              {canWrite ? (
                <div className='grid gap-3 rounded-lg border border-border-card p-4 sm:grid-cols-2'>
                  <div className='space-y-1.5'><Label htmlFor='non-content-origin'>请求来源站点</Label><Input id='non-content-origin' value={nonContentOrigin} onChange={event => setNonContentOrigin(event.target.value)} placeholder='https://metrics.example' /><p className='text-label text-muted-foreground'>填写 http(s) Origin，不含路径或查询。</p></div>
                  <div className='space-y-1.5'><Label htmlFor='non-content-path'>请求精确路径</Label><Input id='non-content-path' value={nonContentPath} onChange={event => setNonContentPath(event.target.value)} placeholder='/collect' /><p className='text-label text-muted-foreground'>不含查询参数或通配符。</p></div>
                  <div className='space-y-1.5'><Label htmlFor='non-content-type'>浏览器请求类型</Label><SelectField id='non-content-type' className='w-full' value={nonContentResourceType} onValueChange={value => setNonContentResourceType(value as 'xhr' | 'fetch')}><SelectFieldOption value='xhr'>XHR</SelectFieldOption><SelectFieldOption value='fetch'>fetch</SelectFieldOption></SelectField></div>
                  <div className='space-y-1.5 sm:col-span-2'><Label htmlFor='non-content-evidence'>核实依据</Label><Input id='non-content-evidence' value={nonContentEvidence} onChange={event => setNonContentEvidence(event.target.value)} placeholder='说明请求用途及为何不参与页面内容' /></div>
                  <div className='sm:col-span-2 flex justify-end'>
                    <Button variant='outline' disabled={mutation.isPending || !validNonContentOrigin || !validNonContentPath || nonContentEvidence.trim().length < 12} onClick={() => mutation.mutate({ readOnlyRequests, verifiedNonContentRequests: [...verifiedNonContentRequests, { method: 'POST', resourceType: nonContentResourceType, origin: nonContentOrigin.trim(), pathPattern: nonContentPath.trim(), evidence: nonContentEvidence.trim() }] })}>添加核实规则</Button>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
