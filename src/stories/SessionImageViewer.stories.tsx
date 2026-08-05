import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { Button } from '@/components/ui/button'
import { SessionImageViewer } from '@/features/session/SessionImageViewer'
import type { SessionImage } from '@/features/session/notesStore'

const IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const IMAGE_BYTES = Uint8Array.from(
  atob(IMAGE_DATA_URL.split(',')[1]),
  (character) => character.charCodeAt(0)
)

const image: SessionImage = {
  id: 'alice:1:1',
  fromEdPubkeyHex: 'alice',
  mine: false,
  blob: new Blob([IMAGE_BYTES], { type: 'image/png' }),
  objectUrl: IMAGE_DATA_URL,
  filename: 'linear-algebra-notes.png',
  mimeType: 'image/png',
  width: 1,
  height: 1,
  frameCount: 1,
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
