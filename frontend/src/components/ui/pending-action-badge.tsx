import { type LucideIcon } from 'lucide-react'
import { Button } from './button'
import { cn } from '@/lib/utils'

type BadgeColor = 'orange' | 'blue'

const colorStyles: Record<BadgeColor, { bg: string; hover: string; text: string }> = {
  orange: {
    bg: 'bg-orange-500/10',
    hover: 'hover:bg-orange-500/20',
    text: 'text-orange-500',
  },
  blue: {
    bg: 'bg-blue-500/10',
    hover: 'hover:bg-blue-500/20',
    text: 'text-blue-500',
  },
}

interface PendingActionBadgeProps {
  count: number
  icon: LucideIcon
  color: BadgeColor
  onClick: () => void
  label: string
  className?: string
}

export function PendingActionBadge({
  count,
  icon: Icon,
  color,
  onClick,
  label,
  className,
}: PendingActionBadgeProps) {
  if (count === 0) return null

  const styles = colorStyles[color]

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      className={cn(
        'relative h-8 w-8 transition-all duration-200',
        styles.bg,
        styles.hover,
        styles.text,
        className
      )}
      title={`${count} pending ${label}${count > 1 ? 's' : ''}`}
    >
      <Icon className="w-4 h-4" />
      <span
        className={cn(
          'absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full animate-pulse',
          color === 'orange' ? 'bg-orange-500' : 'bg-blue-500'
        )}
      />
    </Button>
  )
}
