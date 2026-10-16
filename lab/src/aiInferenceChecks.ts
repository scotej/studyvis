import type { FocusChatRequest } from '../../src/features/ai/focusRequest'

type SyntheticImages = {
  faceBase64: string
  screenBase64: string
  mimeType: string
}

// A valid text-only response cannot prove that the multimodal adapter works.
// Validate the exact synthetic frames immediately before sending the request.
export function assertSyntheticFocusImages(
  request: FocusChatRequest,
  images: SyntheticImages
): 2 {
  if (!/^image\/(?:jpeg|png)$/.test(images.mimeType))
    throw new Error('synthetic focus image MIME type is unsupported')
  const payloads = [images.faceBase64, images.screenBase64]
  for (const payload of payloads) {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        payload
      ) ||
      atob(payload).length === 0
    ) {
      throw new Error('synthetic focus image payload must be nonempty base64')
    }
  }
  const urls = request.messages
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : []
    )
    .filter((block) => block.type === 'image_url')
    .map((block) => block.image_url.url)
  if (urls.length !== 2)
    throw new Error('focus request must contain exactly two synthetic images')
  const expected = payloads.map(
    (payload) => `data:${images.mimeType};base64,${payload}`
  )
  if (urls.some((url, index) => url !== expected[index]))
    throw new Error('focus request images differ from the synthetic frames')
  return 2
}
