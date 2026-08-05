from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"missing replacement anchor in {path}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


# Preserve parser-derived animation information through verification.
replace(
    "src/features/session/images.ts",
    "export type VerifiedImagePayload = {\n  blob: Blob\n  metadata: ImageMetadata\n}",
    "export type VerifiedImagePayload = {\n  blob: Blob\n  metadata: ImageMetadata\n  frameCount: number\n}",
)
replace(
    "src/features/session/images.ts",
    "  return {\n    blob: new Blob([bytes.slice()], { type: value.mime_type }),\n    metadata: { ...core, sig: value.sig },\n  }",
    "  return {\n    blob: new Blob([bytes.slice()], { type: value.mime_type }),\n    metadata: { ...core, sig: value.sig },\n    frameCount: inspection.frameCount,\n  }",
)
replace(
    "src/features/session/images.ts",
    "  const inspection =\n    mimeType === 'image/png'\n      ? inspectPng(bytes)\n      : mimeType === 'image/jpeg'\n        ? inspectJpeg(bytes)\n        : mimeType === 'image/gif'\n          ? inspectGif(bytes)\n          : inspectWebp(bytes)",
    "  const inspectors: Record<\n    ImageMimeType,\n    (input: Uint8Array) => ImageInspection | null\n  > = {\n    'image/png': inspectPng,\n    'image/jpeg': inspectJpeg,\n    'image/webp': inspectWebp,\n    'image/gif': inspectGif,\n  }\n  const inspection = inspectors[mimeType](bytes)",
)

# Bound retained encoded and decoded image resources independently from notes.
replace(
    "src/features/session/notesStore.ts",
    "export const NOTES_CAP = 100",
    "export const NOTES_CAP = 100\nexport const IMAGES_CAP = 12\nexport const IMAGES_MAX_STORED_BYTES = 20 * 1024 * 1024\nexport const IMAGES_MAX_STORED_PIXELS = 64 * 1024 * 1024",
)
replace(
    "src/features/session/notesStore.ts",
    "  height: number\n  ts: number",
    "  height: number\n  frameCount: number\n  ts: number",
)
replace(
    "src/features/session/notesStore.ts",
    "      const next = [...s.images, entry]\n      const kept = next.length > NOTES_CAP ? next.slice(-NOTES_CAP) : next\n      for (const removed of next.slice(0, next.length - kept.length)) {\n        URL.revokeObjectURL(removed.objectUrl)\n      }\n      return { images: kept }",
    "      const next = [...s.images, entry]\n      const kept = [...next]\n      let encodedBytes = kept.reduce((total, item) => total + item.blob.size, 0)\n      let decodedPixels = kept.reduce(\n        (total, item) => total + item.width * item.height * item.frameCount,\n        0\n      )\n      while (\n        kept.length > IMAGES_CAP ||\n        encodedBytes > IMAGES_MAX_STORED_BYTES ||\n        decodedPixels > IMAGES_MAX_STORED_PIXELS\n      ) {\n        const removed = kept.shift()\n        if (!removed) break\n        encodedBytes -= removed.blob.size\n        decodedPixels -= removed.width * removed.height * removed.frameCount\n        URL.revokeObjectURL(removed.objectUrl)\n      }\n      return { images: kept }",
)

# Render all parser-detected animation formats safely under reduced motion.
replace(
    "src/features/session/SessionNotesPanel.tsx",
    "reduceMotion && entry.mimeType === 'image/gif'",
    "reduceMotion && entry.frameCount > 1",
)
replace(
    "src/features/session/SessionImageViewer.tsx",
    "reduceMotion && image.mimeType === 'image/gif'",
    "reduceMotion && image.frameCount > 1",
)

# Track the selected image by ID so eviction/reset closes the viewer.
replace(
    "src/features/session/SessionView.tsx",
    "  const [openSessionImage, setOpenSessionImage] = useState<SessionImage | null>(\n    null\n  )",
    "  const [openSessionImageId, setOpenSessionImageId] = useState<string | null>(\n    null\n  )\n  const openSessionImage =\n    sessionImages.find((image) => image.id === openSessionImageId) ?? null",
)
replace(
    "src/features/session/SessionView.tsx",
    "      useNotesStore.getState().appendImage({\n        fromEdPubkeyHex: verified.metadata.from_ed_pubkey,\n        mine: false,\n        blob: verified.blob,\n        filename: verified.metadata.filename,\n        mimeType: verified.metadata.mime_type,\n        width: verified.metadata.width,\n        height: verified.metadata.height,\n        ts: verified.metadata.ts,\n      })",
    "      void readImageDimensions(verified.blob).then((decoded) => {\n        if (\n          decoded.width !== verified.metadata.width ||\n          decoded.height !== verified.metadata.height\n        ) {\n          return\n        }\n        useNotesStore.getState().appendImage({\n          fromEdPubkeyHex: verified.metadata.from_ed_pubkey,\n          mine: false,\n          blob: verified.blob,\n          filename: verified.metadata.filename,\n          mimeType: verified.metadata.mime_type,\n          width: verified.metadata.width,\n          height: verified.metadata.height,\n          frameCount: verified.frameCount,\n          ts: verified.metadata.ts,\n        })\n      })",
)
replace(
    "src/features/session/SessionView.tsx",
    "      const localBlob = new Blob([payload.bytes.slice()], {\n        type: payload.metadata.mime_type,\n      })\n      useNotesStore.getState().appendImage({\n        fromEdPubkeyHex: myEdPubkeyHex,\n        mine: true,\n        blob: localBlob,\n        filename: payload.metadata.filename,\n        mimeType: payload.metadata.mime_type,\n        width: payload.metadata.width,\n        height: payload.metadata.height,\n        ts: payload.metadata.ts,\n      })\n      await imageAction.send(\n        payload.bytes,\n        undefined,\n        payload.metadata as ImageMetadata\n      )",
    "      await imageAction.send(\n        payload.bytes,\n        undefined,\n        payload.metadata as ImageMetadata\n      )\n      const localBlob = new Blob([payload.bytes.slice()], {\n        type: payload.metadata.mime_type,\n      })\n      const inspection = inspectImageBytes(payload.bytes, payload.metadata.mime_type)\n      if (!inspection) throw new SessionImageError('invalid_image')\n      useNotesStore.getState().appendImage({\n        fromEdPubkeyHex: myEdPubkeyHex,\n        mine: true,\n        blob: localBlob,\n        filename: payload.metadata.filename,\n        mimeType: payload.metadata.mime_type,\n        width: payload.metadata.width,\n        height: payload.metadata.height,\n        frameCount: inspection.frameCount,\n        ts: payload.metadata.ts,\n      })",
)
replace(
    "src/features/session/SessionView.tsx",
    "  buildImagePayload,\n  IMAGE_ACTION,",
    "  buildImagePayload,\n  IMAGE_ACTION,\n  inspectImageBytes,",
)
replace(
    "src/features/session/SessionView.tsx",
    "            onOpenImage={setOpenSessionImage}",
    "            onOpenImage={(image) => setOpenSessionImageId(image.id)}",
)
replace(
    "src/features/session/SessionView.tsx",
    "          if (!open) setOpenSessionImage(null)",
    "          if (!open) setOpenSessionImageId(null)",
)

# Ensure every constructed SessionImage supplies parser-derived frame count.
for path in [
    "src/stories/SessionImageViewer.stories.tsx",
    "src/stories/SessionNotesPanel.stories.tsx",
    "tests/unit/session-images.test.ts",
]:
    text = Path(path).read_text()
    text = text.replace("      height: 10,\n      ts:", "      height: 10,\n      frameCount: 1,\n      ts:")
    text = text.replace("  height: 540,\n  ts:", "  height: 1,\n  frameCount: 1,\n  ts:")
    Path(path).write_text(text)

# Replace the malformed PNG fixture with a real decodable 1x1 PNG.
replace(
    "tests/unit/session-images.test.ts",
    "const VALID_PNG_BYTES = new Uint8Array([\n  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,\n  1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68,\n  65, 84, 120, 218, 99, 252, 255, 31, 0, 2, 235, 1, 245, 143, 89, 210, 45,\n  0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,\n])",
    "const VALID_PNG_BYTES = new Uint8Array([\n  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,\n  1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68,\n  65, 84, 120, 218, 99, 252, 207, 192, 80, 15, 0, 5, 131, 2, 127, 150, 31,\n  89, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,\n])",
)

# Make the viewer story preview and download the same real PNG bytes.
replace(
    "src/stories/SessionImageViewer.stories.tsx",
    "import { tokens } from '@/design/tokens'\n",
    "",
)
start = Path("src/stories/SessionImageViewer.stories.tsx").read_text()
old = start[start.index("const IMAGE_URL ="):start.index("const image: SessionImage")]
new = "const IMAGE_DATA_URL =\n  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lh9ZAAAAAElFTkSuQmCC'\nconst IMAGE_BYTES = Uint8Array.from(\n  atob(IMAGE_DATA_URL.split(',')[1]),\n  (character) => character.charCodeAt(0)\n)\n\n"
Path("src/stories/SessionImageViewer.stories.tsx").write_text(start.replace(old, new, 1))
replace(
    "src/stories/SessionImageViewer.stories.tsx",
    "  blob: new Blob(['storybook image'], { type: 'image/png' }),\n  objectUrl: IMAGE_URL,",
    "  blob: new Blob([IMAGE_BYTES], { type: 'image/png' }),\n  objectUrl: IMAGE_DATA_URL,",
)
replace(
    "src/stories/SessionImageViewer.stories.tsx",
    "  width: 960,\n  height: 1,",
    "  width: 1,\n  height: 1,",
)

# Add image-save orchestration coverage.
path = Path("tests/unit/session-images.test.ts")
text = path.read_text()
text = text.replace(
    "import { useNotesStore } from '@/features/session/notesStore'",
    "import { saveSessionImage } from '@/features/session/imageSave'\nimport { useNotesStore } from '@/features/session/notesStore'",
)
text += """

describe('session image save', () => {
  test('writes exact bytes after a chosen path', async () => {
    const writeFile = vi.fn(async () => {})
    const result = await saveSessionImage(
      new Blob([VALID_PNG_BYTES], { type: 'image/png' }),
      'image.png',
      'image/png',
      {
        pickPath: async () => '/tmp/image.png',
        writeFile,
      }
    )
    expect(result).toBe('saved')
    expect(writeFile).toHaveBeenCalledWith(
      '/tmp/image.png',
      Array.from(VALID_PNG_BYTES)
    )
  })

  test('does not write when the dialog is cancelled', async () => {
    const writeFile = vi.fn(async () => {})
    const result = await saveSessionImage(
      new Blob([VALID_PNG_BYTES], { type: 'image/png' }),
      'image.png',
      'image/png',
      {
        pickPath: async () => null,
        writeFile,
      }
    )
    expect(result).toBe('cancelled')
    expect(writeFile).not.toHaveBeenCalled()
  })
})
"""
path.write_text(text)
