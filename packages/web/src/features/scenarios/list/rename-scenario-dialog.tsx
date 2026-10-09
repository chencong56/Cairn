import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { scenarioNameSchema, type ScenarioDto } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { updateScenario } from '@/lib/scenarios-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function RenameScenarioDialog({
  scenario,
  onOpenChange,
}: {
  scenario: ScenarioDto | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={Boolean(scenario)} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        {scenario ? <RenameForm key={scenario.id} scenario={scenario} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({ scenario, onDone }: { scenario: ScenarioDto; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(scenario.name)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const parsed = scenarioNameSchema.safeParse(name.trim())
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '名称不合法')
      return
    }
    if (parsed.data === scenario.name) {
      onDone()
      return
    }
    setSaving(true)
    try {
      await updateScenario(scenario.id, { name: parsed.data })
      await queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      toast.success('已重命名')
      onDone()
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : '重命名失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <DialogHeader>
        <DialogTitle>重命名场景</DialogTitle>
        <DialogDescription>只改名称，不影响步骤、版本与运行记录。</DialogDescription>
      </DialogHeader>
      <div className='my-4 space-y-2'>
        <Label htmlFor='rename-scenario'>
          场景名称<span className='ml-0.5 text-status-error-foreground'>*</span>
        </Label>
        <Input
          id='rename-scenario'
          value={name}
          autoFocus
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
        />
        {error ? <p className='text-label text-status-error-foreground'>{error}</p> : null}
      </div>
      <DialogFooter>
        <Button type='button' variant='outline' disabled={saving} onClick={onDone}>
          取消
        </Button>
        <Button type='submit' loading={saving}>
          保存
        </Button>
      </DialogFooter>
    </form>
  )
}
