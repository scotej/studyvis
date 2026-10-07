import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { PairQrCode } from '@/components/PairQrCode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { strings } from '@/strings'
import type { MirrorConfig } from './wire'

export type MirrorHostPanelProps = {
  config: MirrorConfig | null
  starting: boolean
  connected: boolean
  takeover: boolean
  onStart: () => Promise<void>
  onStop: () => Promise<void>
}

export function MirrorHostPanel({
  config,
  starting,
  connected,
  takeover,
  onStart,
  onStop,
}: MirrorHostPanelProps) {
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const [stopping, setStopping] = useState(false)
  const copy = strings.mirror
  const expired = config !== null && now >= config.expiresAt
  useEffect(() => {
    if (!config) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [config])
  const start = async () => {
    setError(null)
    try {
      await onStart()
    } catch {
      setError(copy.failed)
    }
  }
  const copyLink = async (url: string, certificate = false) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(certificate ? copy.certificateCopied : copy.copied)
    } catch {
      toast.error(copy.copyFailed)
    }
  }
  const stop = async (restart = false) => {
    setStopping(true)
    setError(null)
    try {
      await onStop()
      if (restart) await onStart()
    } catch {
      setError(restart ? copy.failed : copy.stopFailed)
    } finally {
      setStopping(false)
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">{copy.intro}</p>
      {error ? (
        <p role="alert" className="text-sm text-status-alerted">
          {error}
        </p>
      ) : null}
      {expired ? (
        <>
          <p role="status" className="text-sm text-text-secondary">
            {copy.expired}
          </p>
          <Button
            disabled={starting || stopping}
            onClick={() => void stop(true)}
          >
            {copy.restart}
          </Button>
        </>
      ) : config ? (
        <>
          <p role="status" className="text-sm font-medium">
            {connected ? copy.connected : copy.waiting}
          </p>
          {takeover ? (
            <p className="text-sm text-text-secondary">{copy.takeover}</p>
          ) : null}
          <p className="text-sm text-text-secondary">{copy.certificate}</p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mirror-certificate-url">
              {copy.certificateDownload}
            </Label>
            <div className="flex gap-2">
              <Input
                id="mirror-certificate-url"
                readOnly
                value={config.certificateUrl}
              />
              <Button
                variant="secondary"
                onClick={() => void copyLink(config.certificateUrl, true)}
              >
                {copy.copy}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mirror-fingerprint">{copy.fingerprint}</Label>
            <Input
              id="mirror-fingerprint"
              readOnly
              value={config.fingerprint}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mirror-password">{copy.password}</Label>
            <Input
              id="mirror-password"
              readOnly
              value={config.password}
              className="font-mono"
            />
          </div>
          {config.urls.map((url, index) => (
            <div key={url} className="flex flex-col gap-2">
              <Label htmlFor={`mirror-url-${index}`}>{copy.link}</Label>
              <div className="flex gap-2">
                <Input id={`mirror-url-${index}`} readOnly value={url} />
                <Button variant="secondary" onClick={() => void copyLink(url)}>
                  {copy.copy}
                </Button>
              </div>
            </div>
          ))}
          {config.urls[0] ? (
            <div className="self-center">
              <PairQrCode value={config.urls[0]} label={copy.link} />
            </div>
          ) : null}
          <Button
            variant="secondary"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {copy.stop}
          </Button>
        </>
      ) : (
        <Button onClick={() => void start()} disabled={starting}>
          {starting ? copy.starting : copy.start}
        </Button>
      )}
    </div>
  )
}
