import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { MAX_CONCURRENT_SESSIONS_LIMIT, TARGET_STATUSES, type TargetAccountDto } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { updateTargetAccount } from '@/lib/targets-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TARGET_STATUS_LABELS } from './labels'

const formSchema = z.object({
  displayName: z.string().trim().min(1, '请填写显示名。').max(128),
  status: z.enum(TARGET_STATUSES),
  maxConcurrentSessions: z.coerce.number().int().min(1).max(MAX_CONCURRENT_SESSIONS_LIMIT),
})
type FormValues = z.output<typeof formSchema>

/**
 * 访客没有登录名、口令和有效期，只能改显示名、启用状态与并发上限。
 * 访客不受「一个账号同时只能在线一个会话」限制，并发上限不看目标会话模式。
 */
export function VisitorAccountDialog({
  open,
  onOpenChange,
  targetId,
  current,
  noLoginTarget,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetId: string
  current: TargetAccountDto
  /** 无需登录的目标只有访客这一个身份，不能停用。 */
  noLoginTarget: boolean
}) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const form = useForm<z.input<typeof formSchema>, unknown, FormValues>({
    resolver: zodResolver(formSchema),
    values: {
      displayName: current.displayName,
      status: current.status,
      maxConcurrentSessions: current.maxConcurrentSessions ?? 1,
    },
  })

  const onSubmit = async (values: FormValues) => {
    setSaving(true)
    try {
      await updateTargetAccount(targetId, current.id, {
        ...(values.displayName !== current.displayName ? { displayName: values.displayName } : {}),
        ...(values.status !== current.status ? { status: values.status } : {}),
        ...(values.maxConcurrentSessions !== (current.maxConcurrentSessions ?? 1)
          ? { maxConcurrentSessions: values.maxConcurrentSessions }
          : {}),
      })
      toast.success('访客已更新')
      await queryClient.invalidateQueries({ queryKey: ['target', targetId] })
      await queryClient.invalidateQueries({ queryKey: ['target-accounts', targetId] })
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const unchanged =
    form.watch('displayName') === current.displayName &&
    form.watch('status') === current.status &&
    Number(form.watch('maxConcurrentSessions')) === (current.maxConcurrentSessions ?? 1)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>编辑访客</DialogTitle>
          <DialogDescription>
            访客不登录、没有凭据；场景选它运行时不会探测登录态，也不会等人工认证。
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className='space-y-4' onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name='displayName'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    显示名 <span className='font-bold text-destructive' aria-hidden='true'>*</span>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='status'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>状态</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange} disabled={noLoginTarget}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TARGET_STATUSES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {TARGET_STATUS_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {noLoginTarget ? (
                    <p className='text-label text-muted-foreground'>无需登录的目标只有访客这一个身份，不能停用。</p>
                  ) : (
                    <p className='text-label text-muted-foreground'>停用等同于关闭「允许访客运行」；仍有启用中的调度在用访客时不能停用。</p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='maxConcurrentSessions'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>同时在线会话上限</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={1}
                      max={MAX_CONCURRENT_SESSIONS_LIMIT}
                      step={1}
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={field.value as number | string}
                      onChange={(event) => field.onChange(event.target.value)}
                    />
                  </FormControl>
                  <p className='text-label text-muted-foreground'>
                    访客可以同时开多个浏览器会话并行跑场景，最多 {MAX_CONCURRENT_SESSIONS_LIMIT} 个。
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className='gap-2.5'>
              <Button type='button' variant='outline' disabled={saving} onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button type='submit' loading={saving} disabled={unchanged}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
