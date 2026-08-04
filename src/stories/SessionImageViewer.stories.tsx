import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button } from '@/components/ui/button'
import { tokens } from '@/design/tokens'
import { SessionImageViewer } from '@/features/session/SessionImageViewer'
import type { SessionImage } from '@/features/session/notesStore'

const IMAGE_URL =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
      <rect width="960" height="540" fill="${tokens.color.bg.surface}"/>
      <rect x="96" y="72" width="768" height="396" rx="24" fill="${tokens.color.bg.raised}" stroke="${tokens.color.accent.default}" stroke-width="8"/>
      <text x="480" y="250" text-anchor="middle" fill="${tokens.color.text.primary}" font-family="sans-serif" font-size="48">Study notes</text>
      <text x="480" y="320" text-anchor="middle" fill="${tokens.color.text.secondary}" font-family="sans-serif" font-size="28">Click zoom or download</text>
    </svg>
  `)

const image: SessionImage = {
  id: 'alice:1:1',
  fromEdPubkeyHex: 'alice',
  mine: false,
  blob: new Blob(['storybook image'], { type: 'image/png' }),
  objectUrl: IMAGE_URL,
  filename: 'linear-algebra-notes.png',
  mimeType: 'image/png',
  width: 960,
  height: 540,
  ts: 1,
}

function ViewerStory() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Open image
      </Button>
      <SessionImageViewer
        image={open ? image : null}
        onOpenChange={setOpen}
        resolveName={() => 'Alice'}
      />
    </>
  )
}

const meta = {
  title: 'Session/SessionImageViewer',
  component: SessionImageViewer,
  args: {
    image,
    onOpenChange: () => {},
    resolveName: () => 'Alice',
  },
  render: () => <ViewerStory />,
} satisfies Meta<typeof SessionImageViewer>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
