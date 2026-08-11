export type BridgeEvent = { payload: unknown }
export type BridgeUnlisten = () => void
export type BridgeListen = (
  eventName: string,
  handler: (event: BridgeEvent) => void
) => Promise<BridgeUnlisten>

export type PttBridgeEventNames = {
  physicalState: string
  released: string
  pressed: string
}

export type PttBridgeHandlers = {
  onPhysicalState: (payload: unknown) => void
  onReleased: () => void
  onPressed: () => void
}

// Registration is transactional and deliberately release-first. PTT must not
// gain an activating Pressed listener unless every deactivation/reconciliation
// listener is already live. If any registration rejects, unwind every listener
// staged by this attempt before propagating the error.
export async function registerPttEventBridge(
  listen: BridgeListen,
  names: PttBridgeEventNames,
  handlers: PttBridgeHandlers
): Promise<BridgeUnlisten[]> {
  const staged: BridgeUnlisten[] = []
  try {
    staged.push(
      await listen(names.physicalState, (event) =>
        handlers.onPhysicalState(event.payload)
      )
    )
    staged.push(await listen(names.released, handlers.onReleased))
    staged.push(await listen(names.pressed, handlers.onPressed))
    return staged
  } catch (error) {
    for (const unlisten of staged.reverse()) unlisten()
    throw error
  }
}
