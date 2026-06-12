import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

import { Skeleton } from '@/components/ui/skeleton'

export type PairQrCodeProps = {
  value: string
  label: string
  size?: number
}

// F9 — EC level 'Q' (~25% recovery) over 'M' (~15%): the short pairing link
// fits well within 'Q' capacity, and the extra redundancy markedly improves a
// laptop webcam scanning another screen across a desk. Size bumped from 192 to
// 224 for the same reason — denser EC needs more pixels per module to stay
// crisp on a camera. Both are pure scan-reliability wins; the encoded payload
// is unchanged so existing scanners still decode it.
const QR_SIZE = 224
const QR_EC_LEVEL = 'Q'

// Renders an arbitrary string as a scannable QR image. Generic — it knows
// nothing about pairing; the caller decides what `value` means. Black-on-white
// (qrcode's default) for maximum scan reliability regardless of app theme; the
// generated data URL carries its own white quiet zone.
export function PairQrCode({ value, label, size = QR_SIZE }: PairQrCodeProps) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(value, {
      margin: 2,
      width: size,
      errorCorrectionLevel: QR_EC_LEVEL,
    })
      .then((url) => {
        if (!cancelled) setSrc(url)
      })
      .catch(() => {
        if (!cancelled) setSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [value, size])

  if (!src) {
    return <Skeleton className="aspect-square w-56 rounded-lg" />
  }

  return (
    <img
      src={src}
      alt={label}
      width={size}
      height={size}
      className="rounded-lg border border-border-default"
    />
  )
}
