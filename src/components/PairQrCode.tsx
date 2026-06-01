import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

import { Skeleton } from '@/components/ui/skeleton'

export type PairQrCodeProps = {
  value: string
  label: string
  size?: number
}

// Renders an arbitrary string as a scannable QR image. Generic — it knows
// nothing about pairing; the caller decides what `value` means. Black-on-white
// (qrcode's default) for maximum scan reliability regardless of app theme; the
// generated data URL carries its own white quiet zone.
export function PairQrCode({ value, label, size = 192 }: PairQrCodeProps) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(value, {
      margin: 2,
      width: size,
      errorCorrectionLevel: 'M',
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
    return <Skeleton className="aspect-square w-48 rounded-lg" />
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
