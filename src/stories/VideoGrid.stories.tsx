import { useEffect, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button } from '@/components/ui/button'
import { VideoGrid } from '@/components/VideoGrid'
import { VideoTile } from '@/components/VideoTile'
import { tokens } from '@/design/tokens'
import { cn } from '@/lib/utils'
import { strings } from '@/strings'

function useColorStream(
  label: string,
  color: string,
  width = 640,
  height = 360
): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
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
  }, [color, label, width, height])
  return stream
}

const PEERS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'You', color: tokens.color.accent.default },
  { name: 'Alice', color: tokens.color.status.focused },
  { name: 'Bo', color: tokens.color.accent.muted },
  { name: 'Mei', color: tokens.color.accent.active },
]

// #95 — the grid sizes its tiles from the slot it is given, so these stories
// hand it the whole frame (`layout: 'fullscreen'`) the way SessionView hands it
// everything left between the media banner and the footer. In a padded box with
// no height it would have nothing to fill.
//
// #96 — `sharing` adds a screen tile after that person's camera tile, the same
// order SessionView emits them in. A screen counts as a tile like any other, so
// two people who are both sharing is a four-tile grid.
function GridScene({
  count,
  sharing = 0,
  className,
}: {
  count: number
  sharing?: number
  className?: string
}) {
  const tiles = []
  for (let i = 0; i < count; i += 1) {
    const peer = PEERS[i % PEERS.length]!
    tiles.push(
      <CameraTile
        key={peer.name}
        name={peer.name}
        color={peer.color}
        isLocal={i === 0}
      />
    )
    if (i < sharing) {
      tiles.push(
        <ScreenTile
          key={`${peer.name}-screen`}
          name={peer.name}
          own={i === 0}
        />
      )
    }
  }
  return (
    <div className={cn('h-full p-6', className)}>
      <VideoGrid className="h-full">{tiles}</VideoGrid>
    </div>
  )
}

function CameraTile({
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

// A 16:10 source, so the letterboxing a screen tile does (`object-contain` — a
// cropped screen loses whatever is being pointed at) is visible rather than
// implied.
function ScreenTile({ name, own }: { name: string; own?: boolean }) {
  const label = own
    ? strings.session.screenShare.selfTileName
    : strings.session.screenShare.peerTileName(name)
  const stream = useColorStream(label, tokens.color.bg.surface, 1600, 1000)
  return (
    <VideoTile
      name={label}
      stream={stream}
      variant="screen"
      isLocal={own}
      onExpand={() => {}}
    />
  )
}

const meta = {
  title: 'Components/VideoGrid',
  component: VideoGrid,
  parameters: { layout: 'fullscreen' },
  args: { children: null },
} satisfies Meta<typeof VideoGrid>

export default meta
type Story = StoryObj<typeof meta>

export const OneTile: Story = { render: () => <GridScene count={1} /> }
export const TwoTiles: Story = { render: () => <GridScene count={2} /> }
export const ThreeTiles: Story = { render: () => <GridScene count={3} /> }
export const FourTiles: Story = { render: () => <GridScene count={4} /> }

// #96 — two people who are both sharing: four tiles, sized exactly as four
// people would be. A screen is a tile like any other.
export const TwoPeopleBothSharing: Story = {
  render: () => <GridScene count={2} sharing={2} />,
}

// The ceiling — four people each also publishing a screen. Eight tiles is where
// they stop growing to fill the slot and go back to fitting into it.
export const FourPeopleAllSharing: Story = {
  render: () => <GridScene count={4} sharing={4} />,
}

// #95 × #96 — a share starting mid-session is a tile appearing, so everyone
// re-fits around it. The tiles that were already there keep their identity: the
// grid keys each slot by the child's own key, so nobody's video element is torn
// down and re-created (which would flash black and drop the bound stream).
export const ScreenShareStarts: Story = {
  render: function ScreenShareStartsStory() {
    const [sharing, setSharing] = useState(0)
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() => setSharing((cur) => (cur === 0 ? 1 : 0))}
        >
          {sharing === 0 ? 'Start sharing' : 'Stop sharing'}
        </Button>
        <GridScene count={2} sharing={sharing} className="min-h-0 flex-1 p-0" />
      </div>
    )
  },
}
