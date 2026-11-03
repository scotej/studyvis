import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Disclosure } from '@/components/Disclosure'
import { PairQrCode } from '@/components/PairQrCode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { strings } from '@/strings'
import type { MirrorDiagnostic } from './runtime'
import { reachableAddresses } from './addresses'
import type { MirrorConfig } from './wire'

export type MirrorHostPanelProps = {
  config: MirrorConfig | null
  starting: boolean
  connected: boolean
  takeover: boolean
  diagnostic?: MirrorDiagnostic | null
  onStart: () => Promise<void>
  onStop: () => Promise<void>
}

export function MirrorHostPanel({
  config,
  starting,
  connected,
  takeover,
  diagnostic = null,
  onStart,
  onStop,
}: MirrorHostPanelProps) {
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const [stopping, setStopping] = useState(false)
  const [selected, setSelected] = useState<{
    generation: string
    url: string
  } | null>(null)
  const copy = strings.mirror
  const addresses = config ? reachableAddresses(config) : []
  const chosen =
    (selected && selected.generation === config?.generation
      ? addresses.find((address) => address.url === selected.url)
      : undefined) ?? addresses[0]
  const url = chosen?.url
  const certificateUrl =
    chosen?.certificateUrl ??
    config?.certificateUrls?.[0] ??
    config?.certificateUrl
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
          {url ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mirror-url">{copy.link}</Label>
                <div className="flex gap-2">
                  <Input
                    id="mirror-url"
                    readOnly
                    value={url}
                    aria-describedby="mirror-url-help"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => void copyLink(url)}
                  >
                    {copy.copy}
                  </Button>
                </div>
                <p id="mirror-url-help" className="text-sm text-text-secondary">
                  {copy.linkHelp}
                </p>
              </div>
              <div className="self-center">
                <PairQrCode value={url} label={copy.link} />
              </div>
            </>
          ) : (
            <p role="alert" className="text-sm text-status-alerted">
              {copy.loopbackOnly}
            </p>
          )}
          {diagnostic && !connected ? (
            <p role="status" className="text-sm text-status-alerted">
              {diagnostic.problem === 'blocked_network'
                ? copy.blockedNetwork(diagnostic.address)
                : copy.certificateRejected(diagnostic.address)}
            </p>
          ) : null}
          {addresses.length > 1 ? (
            <Disclosure
              summary={copy.otherAddresses}
              summaryClassName="text-sm font-medium"
            >
              <div className="mt-3 flex flex-col gap-2">
                <p className="text-sm text-text-secondary">
                  {copy.otherAddressesHelp}
                </p>
                <ul className="flex flex-col gap-2">
                  {addresses.map((address) => (
                    <li
                      key={address.url}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="truncate font-mono text-sm">
                        {address.host}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={address.url === url}
                        aria-label={`${copy.useAddress}: ${address.host}`}
                        onClick={() =>
                          config &&
                          setSelected({
                            generation: config.generation,
                            url: address.url,
                          })
                        }
                      >
                        {address.url === url
                          ? copy.usingAddress
                          : copy.useAddress}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            </Disclosure>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="mirror-password">{copy.password}</Label>
            <Input
              id="mirror-password"
              readOnly
              value={config.password}
              className="font-mono"
            />
          </div>
          <Disclosure
            summary={copy.certificateSetup}
            summaryClassName="text-sm font-medium"
          >
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-sm text-text-secondary">{copy.certificate}</p>
              <Button
                variant="secondary"
                onClick={() =>
                  void copyLink(certificateUrl ?? config.certificateUrl, true)
                }
              >
                {copy.certificateDownload}
              </Button>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mirror-fingerprint">{copy.fingerprint}</Label>
                <Input
                  id="mirror-fingerprint"
                  readOnly
                  value={config.fingerprint}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          </Disclosure>
          {!connected ? (
            <Disclosure
              summary={copy.troubleshooting}
              summaryClassName="text-sm font-medium"
            >
              <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-sm text-text-secondary">
                {copy.troubleshootingSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </Disclosure>
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
