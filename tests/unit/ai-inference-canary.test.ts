import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

import { verifyPinnedFile } from '../../scripts/check-ai-inference'
import { assertSyntheticFocusImages } from '../../lab/src/aiInferenceChecks'
import { buildFocusRequest } from '../../src/features/ai/focusRequest'

test('multimodal canary requires both exact nonempty synthetic image payloads', () => {
  const images = {
    faceBase64: 'ZmFjZQ==',
    screenBase64: 'c2NyZWVu',
    mimeType: 'image/png',
  }
  const request = buildFocusRequest({
    modelId: 'qwen2_5-vl-3b',
    topic: 'Algebra',
    ...images,
    imageMimeType: images.mimeType,
  })
  expect(assertSyntheticFocusImages(request, images)).toBe(2)
  for (const retain of [0, 1]) {
    const dropped = structuredClone(request)
    let remaining = retain
    for (const message of dropped.messages) {
      if (message.role === 'user')
        message.content = message.content.filter(
          (block) => block.type !== 'image_url' || remaining-- > 0
        )
    }
    expect(() => assertSyntheticFocusImages(dropped, images)).toThrow(
      /exactly two/
    )
  }
  for (const replacement of [
    `data:image/png;base64,${images.faceBase64}`,
    'data:image/png;base64,',
    'data:image/png;base64,not-base64!',
  ]) {
    const changed = structuredClone(request)
    const user = changed.messages.find((message) => message.role === 'user')!
    const image = user.content.filter((block) => block.type === 'image_url')[1]!
    image.image_url.url = replacement
    expect(() => assertSyntheticFocusImages(changed, images)).toThrow(
      /differ from the synthetic frames/
    )
  }
  expect(() =>
    assertSyntheticFocusImages(request, { ...images, screenBase64: '' })
  ).toThrow(/nonempty base64/)
  expect(() =>
    assertSyntheticFocusImages(request, { ...images, screenBase64: 'invalid!' })
  ).toThrow(/nonempty base64/)
})

test('real-model canary rejects missing, truncated and hash-corrupt cache entries', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'studyvis-ai-pin-'))
  const file = path.join(dir, 'model.gguf')
  const pin = {
    sizeBytes: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  }
  try {
    await expect(verifyPinnedFile(file, pin)).rejects.toThrow()
    writeFileSync(file, 'ab')
    await expect(verifyPinnedFile(file, pin)).rejects.toThrow(/size mismatch/)
    writeFileSync(file, 'xyz')
    await expect(verifyPinnedFile(file, pin)).rejects.toThrow(
      /SHA-256 mismatch/
    )
    writeFileSync(file, 'abc')
    await expect(verifyPinnedFile(file, pin)).resolves.toBe(pin.sha256)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
