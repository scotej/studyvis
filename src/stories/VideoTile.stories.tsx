import { useEffect, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { VideoTile, type VideoTileProps } from '@/components/VideoTile'
import { tokens } from '@/design/tokens'

// Storybook stories run in a real browser, so HTMLCanvasElement.captureStream
// is available. We animate a colored gradient + label into a hidden canvas
// and capture it as a MediaStream — matches the V1-P8 brief's "mocked streams
// using a colored canvas" without needing a real camera.
function useColorStream(label: string, color: string): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let frame = 0
    const draw = () => {
      ctx.fillStyle = color
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = tokens.color.bg.base
      ctx.fillRect(0, canvas.height - 80, canvas.width, 80)
      ctx.fillStyle = tokens.color.text.primary
      ctx.font = '32px sans-serif'
      ctx.fillText(label, 32, canvas.height - 36)
      ctx.font = '20px sans-serif'
      ctx.fillStyle = tokens.color.text.secondary
      ctx.fillText(`frame ${frame++}`, 32, canvas.height - 12)
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    type CanvasWithCapture = HTMLCanvasElement & {
      captureStream?: (frameRate?: number) => MediaStream
    }
    const c = canvas as CanvasWithCapture
    if (typeof c.captureStream === 'function') {
      setStream(c.captureStream(15))
    }
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      setStream((cur) => {
        cur?.getTracks().forEach((t) => t.stop())
        return null
      })
    }
  }, [color, label])

  return stream
}

function MockedTile(props: Omit<VideoTileProps, 'stream'> & { color: string }) {
  const stream = useColorStream(props.name, props.color)
  return <VideoTile {...props} stream={stream} />
}

const meta = {
  title: 'Components/VideoTile',
  component: VideoTile,
  parameters: { layout: 'padded' },
  args: { name: 'Alice', stream: null },
} satisfies Meta<typeof VideoTile>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="w-full max-w-md">
      <MockedTile name="Alice" color={tokens.color.status.focused} />
    </div>
  ),
}

export const Local: Story = {
  render: () => (
    <div className="w-full max-w-md">
      <MockedTile name="You" color={tokens.color.accent.default} isLocal />
    </div>
  ),
}

export const Transmitting: Story = {
  render: () => (
    <div className="w-full max-w-md">
      <MockedTile name="Bo" color={tokens.color.accent.muted} ptt />
    </div>
  ),
}

export const NoStream: Story = {
  render: () => (
    <div className="w-full max-w-md">
      <VideoTile name="Mei" stream={null} />
    </div>
  ),
}
