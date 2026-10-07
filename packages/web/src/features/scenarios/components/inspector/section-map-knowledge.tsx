import { useState, type ReactNode } from 'react'
import { ChevronDown, Compass } from 'lucide-react'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

export function SectionMapKnowledge({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const canReadMap = useCan('map:read')
  const canWrite = useCan('workflow:write')
  if (!canReadMap || !canWrite) return null

  return (
    <div data-testid='section-map-knowledge' className='border-t border-border-divider pt-3'>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='w-full justify-between px-1.5 py-1 text-label text-muted-foreground hover:text-foreground'
          >
            <div className='flex items-center gap-1.5'>
              <Compass className='size-3.5 text-muted-foreground' />
              <span className='font-medium'>地图知识</span>
            </div>
            <ChevronDown className={`size-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className='space-y-3 pt-3 px-1'>{children}</CollapsibleContent>
      </Collapsible>
    </div>
  )
}
