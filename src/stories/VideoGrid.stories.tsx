import { useEffect, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { VideoGrid } from '@/components/VideoGrid'
import { VideoTile } from '@/components/VideoTile'
import { tokens } from '@/design/tokens'

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

const PEERS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'You', color: tokens.color.accent.default },
  { name: 'Alice', color: tokens.color.status.focused },
  { name: 'Bo', color: tokens.color.accent.muted },
  { name: 'Mei', color: tokens.color.accent.active },
]

function GridWithCount({ count }: { count: 1 | 2 | 3 | 4 }) {
  const tiles = PEERS.slice(0, count).map((p, i) => (
    <Tile key={p.name} name={p.name} color={p.color} isLocal={i === 0} />
  ))
  return (
    <div className="w-full max-w-5xl">
      <VideoGrid>{tiles}</VideoGrid>
    </div>
  )
}

function Tile({
  name,
  color,
  isLocal,
}: {
  name: string
  color: string
  isLocal?: boolean
}) {
  const stream = useColorStream(name, color)
  return <VideoTile name={name} stream={stream} isLocal={isLocal} />
}

const meta = {
  title: 'Components/VideoGrid',
  component: VideoGrid,
  parameters: { layout: 'padded' },
  args: { children: null },
} satisfies Meta<typeof VideoGrid>

export default meta
type Story = StoryObj<typeof meta>

export const OneTile: Story = { render: () => <GridWithCount count={1} /> }
export const TwoTiles: Story = { render: () => <GridWithCount count={2} /> }
export const ThreeTiles: Story = { render: () => <GridWithCount count={3} /> }
export const FourTiles: Story = { render: () => <GridWithCount count={4} /> }
