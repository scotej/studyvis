import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

import { useTheme } from '@/design/theme-context'

const Toaster = ({ ...props }: ToasterProps) => {
  const { mode, resolved } = useTheme()
  const sonnerTheme: ToasterProps['theme'] =
    mode === 'auto' ? 'system' : resolved

  return (
    <Sonner
      theme={sonnerTheme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--bg-raised)',
          '--normal-text': 'var(--text-primary)',
          '--normal-border': 'var(--border-default)',
          '--border-radius': 'var(--radius-token-md)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
