import { useEffect, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { ScreenShareViewer } from '@/components/ScreenShareViewer'
import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'

// Same canvas-capture trick as VideoTile.stories: Storybook runs in a real
// browser, so a hidden canvas stands in for a shared display without needing
// screen-recording permission.
function useScreenStream(label: string): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1440
    canvas.height = 900
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let frame = 0
    const draw = () => {
      ctx.fillStyle = tokens.color.bg.sunk
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = tokens.color.accent.muted
      ctx.fillRect(0, 0, canvas.width, 64)
      ctx.fillStyle = tokens.color.text.primary
      ctx.font = '40px sans-serif'
      ctx.fillText(label, 48, 180)
      ctx.font = '24px sans-serif'
      ctx.fillStyle = tokens.color.text.secondary
      ctx.fillText(`frame ${frame++}`, 48, 232)
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    type CanvasWithCapture = HTMLCanvasElement & {
      captureStream?: (frameRate?: number) => MediaStream
    }
    const c = canvas as CanvasWithCapture
    if (typeof c.captureStream === 'function') setStream(c.captureStream(15))
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      setStream((cur) => {
        cur?.getTracks().forEach((t) => t.stop())
        return null
      })
    }
  }, [label])

  return stream
}

const meta = {
  title: 'Components/ScreenShareViewer',
  component: ScreenShareViewer,
  parameters: { layout: 'centered' },
  args: { open: true, onOpenChange: () => {}, name: 'Alice', stream: null },
} satisfies Meta<typeof ScreenShareViewer>

export default meta
type Story = StoryObj<typeof meta>

function ViewerDemo({ name }: { name: string }) {
  const [open, setOpen] = useState(true)
  const stream = useScreenStream(name)
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Open viewer
      </Button>
      <ScreenShareViewer
        open={open}
        onOpenChange={setOpen}
        name={name}
        stream={stream}
      />
    </>
  )
}

export const Default: Story = {
  render: () => <ViewerDemo name="Alice's screen" />,
}

// Your own share, opened from the local screen tile.
export const OwnScreen: Story = {
  render: () => <ViewerDemo name="Your screen" />,
}

// The stream is gone (the friend stopped sharing between the click and the
// render). The dialog frame still has to be readable rather than collapsing.
export const NoStream: Story = {
  args: { name: "Alice's screen", stream: null },
}
