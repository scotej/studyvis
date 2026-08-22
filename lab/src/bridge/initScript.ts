// Everything the lab injects into a page, before a single line of app code runs.
//
// Nothing in `src/` knows this exists. That is the point: the code a lab
// scenario exercises is byte-identical to what ships, and every seam lives on
// this side of the boundary — Tauri IPC, the relay/broker rendezvous, ICE, and
// the clock.
//
// Playwright serializes this function into the page, so it may not close over
// anything from Node; all configuration arrives through `config`.

export type BridgeConfig = {
  /** Window label this page stands in for ('main', 'session-overlay', …). */
  label: string
  /** Pinned relay/broker hostnames rewritten to the lab's loopback servers.
   *  Keyed by the exact `wss://…` URL the app ships. */
  websocketRewrites: Record<string, string>
  /** Loopback origins a page may still reach (Vite, the llama stub). */
  allowedOrigins: string[]
  /** Milliseconds added to this machine's clock. Reproduces the class of
   *  failure where a skewed peer is invisible to a `since: now()` filter. */
  clockSkewMs: number
}

export function installBridge(config: BridgeConfig): void {
  type EventTarget_ = { kind: string; label?: string }
  type Listener = { id: number; event: string; target: EventTarget_ }

  const w = window as unknown as Record<string, unknown>
  const callbacks = new Map<number, (data: unknown) => unknown>()
  const listeners: Listener[] = []
  const blockedSockets: string[] = []

  // --- clock --------------------------------------------------------------
  if (config.clockSkewMs !== 0) {
    const realNow = Date.now.bind(Date)
    const RealDate = Date
    Date.now = () => realNow() + config.clockSkewMs
    // `new Date()` with no arguments must move too, or the skew is only half
    // applied and nothing reproduces.
    const Patched = new Proxy(RealDate, {
      construct(target, args: unknown[]) {
        if (args.length === 0) {
          return Reflect.construct(target, [realNow() + config.clockSkewMs])
        }
        return Reflect.construct(target, args)
      },
    })
    ;(w as { Date: DateConstructor }).Date = Patched as DateConstructor
  }

  // --- WebSocket ----------------------------------------------------------
  // Discovery is pinned to public relays and brokers. Rewriting the URL here
  // (rather than adding a dev-only override to src/) keeps the app's shipped
  // relay pin under test while the traffic never leaves the machine. Anything
  // that is neither a rewrite target nor loopback is refused loudly: silent
  // egress would make "the lab is offline" a claim rather than a property.
  const RealWebSocket = window.WebSocket
  class LabWebSocket extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const original = String(url)
      const rewritten = rewrite(original)
      if (rewritten === null) {
        blockedSockets.push(original)
        throw new DOMException(
          `lab: refusing non-loopback WebSocket to ${original}`,
          'SecurityError'
        )
      }
      super(rewritten, protocols)
    }
  }
  window.WebSocket = LabWebSocket as unknown as typeof WebSocket

  function rewrite(original: string): string | null {
    const direct = config.websocketRewrites[original]
    if (direct) return direct
    let parsed: URL
    try {
      parsed = new URL(original)
    } catch {
      return null
    }
    // The shipped broker list carries credentials and a path
    // (`wss://public:public@host/mqtt`), so an exact-string match can miss;
    // the hostname always identifies which pinned endpoint this is. The mapped
    // url is used verbatim — it already carries the per-endpoint path that
    // keeps each one a distinct relay as far as the client is concerned.
    const byOrigin =
      config.websocketRewrites[`${parsed.protocol}//${parsed.host}`] ??
      config.websocketRewrites[parsed.hostname]
    if (byOrigin) return byOrigin
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return original
    }
    return null
  }

  // --- ICE ----------------------------------------------------------------
  // Two peers on one machine reach each other on host candidates, so the
  // shipped STUN defaults would only add UDP egress and DNS timeouts. Forcing
  // an empty server list keeps the offline property true end to end.
  const peerConnections: RTCPeerConnection[] = []
  const channelsByConnection = new WeakMap<
    RTCPeerConnection,
    RTCDataChannel[]
  >()
  const createdAt = new WeakMap<RTCPeerConnection, number>()
  const origin = new WeakMap<RTCPeerConnection, string>()
  const RealPeerConnection = window.RTCPeerConnection
  if (RealPeerConnection) {
    class LabPeerConnection extends RealPeerConnection {
      constructor(configuration?: RTCConfiguration) {
        super({ ...configuration, iceServers: [] })
        peerConnections.push(this)
        createdAt.set(this, Date.now())
        origin.set(
          this,
          (new Error().stack ?? '')
            .split('\n')
            .slice(1, 4)
            .map((line) => line.trim())
            .join(' <- ')
        )
        const channels: RTCDataChannel[] = []
        channelsByConnection.set(this, channels)
        this.addEventListener('datachannel', (event) => {
          channels.push((event as RTCDataChannelEvent).channel)
        })
      }

      createDataChannel(
        label: string,
        options?: RTCDataChannelInit
      ): RTCDataChannel {
        const channel = super.createDataChannel(label, options)
        channelsByConnection.get(this)?.push(channel)
        return channel
      }
    }
    window.RTCPeerConnection =
      LabPeerConnection as unknown as typeof RTCPeerConnection
  }

  // --- Tauri IPC ----------------------------------------------------------
  const invokeToNode = w.__labInvoke as (
    cmd: string,
    args: unknown
  ) => Promise<unknown>

  function transformCallback(
    callback?: (data: unknown) => unknown,
    once = false
  ): number {
    const id = window.crypto.getRandomValues(new Uint32Array(1))[0]
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id)
      return callback?.(data)
    })
    return id
  }

  function runCallback(id: number, data: unknown): void {
    callbacks.get(id)?.(data)
  }

  // The event plugin is answered in-page: a listener registry that lives beside
  // the callbacks it dispatches to. Emits still travel to Node, which mirrors
  // them to this machine's other windows — that cross-window hop is real
  // behavior (session overlay, AI dialog), not a lab detail.
  function handleEvent(
    command: string,
    args: Record<string, unknown>
  ): unknown {
    if (command === 'listen') {
      const id = args.handler as number
      listeners.push({
        id,
        event: String(args.event),
        target: (args.target as EventTarget_) ?? { kind: 'Any' },
      })
      return id
    }
    if (command === 'unlisten') {
      const eventId = args.eventId as number
      const index = listeners.findIndex((l) => l.id === eventId)
      if (index >= 0) listeners.splice(index, 1)
      callbacks.delete(eventId)
      return null
    }
    return undefined
  }

  function deliver(event: string, payload: unknown, label?: string): number {
    if (label !== undefined && label !== config.label) return 0
    let delivered = 0
    for (const listener of [...listeners]) {
      if (listener.event !== event) continue
      const target = listener.target
      if (
        target.kind !== 'Any' &&
        target.label !== undefined &&
        target.label !== config.label
      ) {
        continue
      }
      runCallback(listener.id, { event, id: listener.id, payload })
      delivered += 1
    }
    return delivered
  }

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: config.label },
      currentWebview: { label: config.label, windowLabel: config.label },
    },
    transformCallback,
    unregisterCallback: (id: number) => callbacks.delete(id),
    runCallback,
    callbacks,
    convertFileSrc: (filePath: string, protocol = 'asset') =>
      `http://${protocol}.localhost/${encodeURIComponent(filePath)}`,
    async invoke(cmd: string, args: unknown) {
      if (cmd.startsWith('plugin:event|')) {
        const command = cmd.slice('plugin:event|'.length)
        const handled = handleEvent(
          command,
          (args ?? {}) as Record<string, unknown>
        )
        if (handled !== undefined) return handled
      }
      return invokeToNode(cmd, args ?? {})
    },
  }
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, id: number) => callbacks.delete(id),
  }

  // --- lab-facing surface -------------------------------------------------
  w.__lab = {
    label: config.label,
    deliver,
    listeners: () =>
      listeners.map((l) => ({ event: l.event, target: l.target })),
    blockedSockets: () => [...blockedSockets],
    // "Did the two machines actually connect?" is the question behind most
    // session failures, and nothing on screen answers it.
    peers: () =>
      peerConnections.map((pc) => ({
        age: Date.now() - (createdAt.get(pc) ?? Date.now()),
        origin: origin.get(pc) ?? '',
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState,
        sendingTracks: pc.getSenders().filter((s) => s.track).length,
        receivingTracks: pc.getReceivers().filter((r) => r.track).length,
        // Hold-to-talk is a track ENABLED flip, not a DOM change, so it is
        // invisible to a screen snapshot. These are the same counters the
        // app's own push-to-talk watchdog reasons about.
        enabledAudioSenders: pc
          .getSenders()
          .filter((s) => s.track?.kind === 'audio' && s.track.enabled).length,
        audioSenders: pc.getSenders().filter((s) => s.track?.kind === 'audio')
          .length,
        dataChannels: dataChannelsOf(pc),
      })),
  }

  // A room's data channel is what carries an invite, a hello, chat and the
  // audit log; its label and readyState say more than the connection state.
  function dataChannelsOf(pc: RTCPeerConnection): string[] {
    const created = channelsByConnection.get(pc) ?? []
    return created.map((channel) => `${channel.label}:${channel.readyState}`)
  }
}
