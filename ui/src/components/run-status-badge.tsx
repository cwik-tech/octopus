import { Badge } from '@/components/ui/badge'
import type { RunStatus } from '@/lib/models/runtime-model'

const statusVariantMap: Record<RunStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'outline',
  completed: 'outline',
  failed: 'destructive',
  blocked: 'destructive',
  cancelled: 'secondary',
  incomplete: 'outline',
  unknown: 'outline',
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const statusClassName = status === 'active'
    ? 'border-amber-300 bg-amber-50 text-amber-800 capitalize'
    : status === 'completed'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800 capitalize'
      : status === 'blocked'
        ? 'border-destructive/60 text-destructive capitalize'
        : status === 'cancelled'
          ? 'text-muted-foreground capitalize'
      : status === 'incomplete'
        ? 'border-amber-300 text-amber-700 capitalize'
        : 'capitalize'

  return (
    <Badge
      className={statusClassName}
      variant={statusVariantMap[status]}
    >
      {status}
    </Badge>
  )
}
