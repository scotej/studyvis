import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  BotIcon,
  GripHorizontalIcon,
  ImagePlusIcon,
  MessageCircleIcon,
  PlusIcon,
  SendIcon,
  UserIcon,
  XIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useReduceMotion } from '@/design/reduce-motion'
import { AiAgentError, useModelStore } from '@/features/ai'
import { useIdentity } from '@/features/identity'
import { signWithKeyring } from '@/lib/db/identity'
import type { TopicAction } from '@/lib/trystero'
import { useAuditStore } from '@/stores/auditStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { strings } from '@/strings'

import {
  buildDirectMessagePayload,
  DIRECT_MESSAGE_ACTION,
  DIRECT_MESSAGE_MAX_LENGTH,
  sendDirectMessageToPeer,
  type DirectMessagePayload,
  verifyIncomingDirectMessage,
} from './directMessages'
import { NOTE_MAX_LENGTH } from './notes'
import type { SessionImage, SessionNote } from './notesStore'
import {
  handleSessionChatText,
  SESSION_CHAT_MAX_AUDIT_CONTEXT,
  SESSION_CHAT_MAX_MESSAGE_LENGTH,
  type SessionAiMessage,
} from './sessionChatAi'

const MIN_PANEL_HEIGHT = 220
const MAX_PANEL_HEIGHT = 620
const DEFAULT_PANEL_HEIGHT = 300
const MAX_DIRECT_THREAD_MESSAGES = 100
const MAX_AI_THREAD_MESSAGES = 40
const MAX_DIRECT_MESSAGE_IDS = 400

type ChatTab = 'group' | 'ai' | `dm:${string}`

type DirectMessage = {
  id: string
  mine: boolean
  text: string
  ts: number
}

type AiDisplayMessage = SessionAiMessage & {
  id: string
  failed?: boolean
}

const copy = strings.session.chat

function aiErrorCopy(error: unknown): string {
  if (!(error instanceof AiAgentError)) return copy.aiFailed
  switch (error.code) {
    case 'sidecar_unavailable':
      return copy.aiUnavailable
    case 'timeout':
      return copy.aiTimedOut
    default:
      return copy.aiFailed
  }
}

function directMessagesAllowedNow(): boolean {
  const livePeers = Object.values(useSessionStore.getState().peers)
  return livePeers.filter((peer) => peer.edPubkeyHex != null).length >= 2
}

export type SessionNotesPanelProps = {
  notes: ReadonlyArray<SessionNote>
  images: ReadonlyArray<SessionImage>
  resolveName: (item: SessionNote | SessionImage) => string
  onSend: (text: string) => void
  onSendImage: (file: File) => void
  onOpenImage: (image: SessionImage) => void
}

export function SessionNotesPanel({
  notes,
  images,
  resolveName,
  onSend,
  onSendImage,
  onOpenImage,
}: SessionNotesPanelProps) {
  const headingId = useId()
  const noteCopy = strings.session.notes
  const imageCopy = strings.session.images
  const reduceMotion = useReduceMotion()
  const { identity } = useIdentity()
  const room = useSessionStore((state) => state.room)
  const sessionTopic = useSessionStore((state) => state.sessionTopic)
  const peers = useSessionStore((state) => state.peers)
  const declaredStudyTopic = useSessionStore(
    (state) => state.declaredStudyTopic
  )
  const aiFeaturesEnabled = useSettingsStore(
    (state) => state.values.aiFeaturesEnabled
  )
  const activeModelId = useModelStore((state) => state.activeModelId)
  const auditEvents = useAuditStore((state) => state.events)

  const [activeTab, setActiveTab] = useState<ChatTab>('group')
  const [openTabs, setOpenTabs] = useState<ChatTab[]>(['group'])
  const [draft, setDraft] = useState('')
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT)
  const [directMessages, setDirectMessages] = useState<
    Record<string, DirectMessage[]>
  >({})
  const [aiMessages, setAiMessages] = useState<AiDisplayMessage[]>([])
  const [aiSending, setAiSending] = useState(false)
  const [directSending, setDirectSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const stopResizeRef = useRef<(() => void) | null>(null)
  const activeTabRef = useRef<ChatTab>(activeTab)
  const aiAbortRef = useRef<AbortController | null>(null)
  const aiSendingRef = useRef(false)
  const aiRequestGenerationRef = useRef(0)
  const directSendingRef = useRef(false)
  const directSendGenerationRef = useRef(0)
  const directMessageIdsRef = useRef(new Set<string>())
  const directActionRef = useRef<TopicAction<DirectMessagePayload> | undefined>(
    undefined
  )

  activeTabRef.current = activeTab

  const myEdPubkeyHex = identity?.ed_pubkey_hex ?? null
  const peerList = useMemo(
    () =>
      Object.values(peers)
        .filter(
          (peer): peer is typeof peer & { edPubkeyHex: string } =>
            peer.edPubkeyHex != null
        )
        .sort((a, b) =>
          (a.displayName ?? a.edPubkeyHex).localeCompare(
            b.displayName ?? b.edPubkeyHex
          )
        ),
    [peers]
  )
  const peerByEd = useMemo(
    () => new Map(peerList.map((peer) => [peer.edPubkeyHex, peer])),
    [peerList]
  )
  // A one-to-one session already has a private voice channel. DMs become
  // useful only when at least three people are present, matching issue #186.
  const showDirectMessageOptions = peerList.length >= 2
  const aiAvailable = aiFeaturesEnabled && activeModelId != null

  const groupEntries = useMemo(
    () => [...notes, ...images].sort((a, b) => a.ts - b.ts),
    [images, notes]
  )
  const activePeerEd = activeTab.startsWith('dm:') ? activeTab.slice(3) : null
  const activePeer = activePeerEd ? peerByEd.get(activePeerEd) : undefined
  const activeDirectMessages = activePeerEd
    ? (directMessages[activePeerEd] ?? [])
    : []
  const entriesKey =
    activeTab === 'group'
      ? groupEntries.map((entry) => `${entry.id}:${entry.ts}`).join('|')
      : activeTab === 'ai'
        ? aiMessages.map((message) => message.id).join('|')
        : activeDirectMessages.map((message) => message.id).join('|')

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [entriesKey, activeTab])

  useEffect(() => {
    setDraft('')
  }, [activeTab])

  useEffect(() => {
    return () => stopResizeRef.current?.()
  }, [])

  useEffect(() => {
    setActiveTab('group')
    setOpenTabs(['group'])
    setDraft('')
    setDirectMessages({})
    setAiMessages([])
    setAiSending(false)
    aiSendingRef.current = false
    setDirectSending(false)
    directSendingRef.current = false
    directMessageIdsRef.current.clear()
    return () => {
      aiRequestGenerationRef.current += 1
      directSendGenerationRef.current += 1
      aiAbortRef.current?.abort()
      aiAbortRef.current = null
    }
  }, [sessionTopic])

  useEffect(() => {
    if (!room || !sessionTopic || !myEdPubkeyHex) return
    let stopped = false
    const action = room.makeAction<DirectMessagePayload>(DIRECT_MESSAGE_ACTION)
    directActionRef.current = action
    action.receive((data, peerId) => {
      if (stopped || !directMessagesAllowedNow()) return
      const expectedSender =
        useSessionStore.getState().peers[peerId]?.edPubkeyHex ?? null
      const verified = verifyIncomingDirectMessage(
        data,
        expectedSender,
        myEdPubkeyHex,
        sessionTopic
      )
      if (!verified) return
      const peerKey = verified.from_ed_pubkey
      const messageId = verified.sig
      if (directMessageIdsRef.current.has(messageId)) return
      directMessageIdsRef.current.add(messageId)
      if (directMessageIdsRef.current.size > MAX_DIRECT_MESSAGE_IDS) {
        const oldestId = directMessageIdsRef.current.values().next().value
        if (oldestId) directMessageIdsRef.current.delete(oldestId)
      }
      setDirectMessages((current) => ({
        ...current,
        [peerKey]: [
          ...(current[peerKey] ?? []),
          {
            id: messageId,
            mine: false,
            text: verified.text,
            ts: verified.ts,
          },
        ].slice(-MAX_DIRECT_THREAD_MESSAGES),
      }))
      setOpenTabs((current) => {
        const tab = `dm:${peerKey}` as const
        return current.includes(tab) ? current : [...current, tab]
      })
    })
    return () => {
      stopped = true
      directActionRef.current = undefined
    }
  }, [myEdPubkeyHex, room, sessionTopic])

  // Close stale DM tabs when a peer leaves; messages remain in memory only
  // until the session view unmounts, so a reconnect can restore the thread.
  useEffect(() => {
    const focusedTab = document.activeElement
      ?.closest<HTMLElement>('[data-chat-tab]')
      ?.getAttribute('data-chat-tab') as ChatTab | null | undefined
    const activeDirectTabInvalid =
      activePeerEd != null &&
      (!showDirectMessageOptions || !peerByEd.has(activePeerEd))
    setOpenTabs((current) => {
      const next = current.filter(
        (tab) =>
          !tab.startsWith('dm:') ||
          (showDirectMessageOptions && peerByEd.has(tab.slice(3)))
      )
      return next.length === current.length ? current : next
    })
    if (activeDirectTabInvalid) setActiveTab('group')
    if (
      focusedTab?.startsWith('dm:') &&
      (!showDirectMessageOptions || !peerByEd.has(focusedTab.slice(3)))
    ) {
      requestAnimationFrame(() =>
        document.getElementById(`${headingId}-tab-group`)?.focus()
      )
    }
  }, [activePeerEd, headingId, peerByEd, showDirectMessageOptions])

  const openTab = (tab: ChatTab) => {
    if (
      tab.startsWith('dm:') &&
      (!showDirectMessageOptions || !peerByEd.has(tab.slice(3)))
    ) {
      return
    }
    setOpenTabs((current) =>
      current.includes(tab) ? current : [...current, tab]
    )
    setActiveTab(tab)
  }

  const closeTab = (tab: ChatTab) => {
    if (tab === 'group') return
    const tabIndex = openTabs.indexOf(tab)
    const nextTabs = openTabs.filter((candidate) => candidate !== tab)
    const nextActive =
      activeTab === tab
        ? (nextTabs[Math.max(0, tabIndex - 1)] ?? 'group')
        : activeTab
    setOpenTabs(nextTabs)
    setActiveTab(nextActive)
    requestAnimationFrame(() =>
      document.getElementById(tabId(nextActive))?.focus()
    )
  }

  const submitGroup = () => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }

  const submitDirectMessage = async () => {
    const text = draft.trim()
    if (
      !text ||
      directSendingRef.current ||
      !showDirectMessageOptions ||
      !activePeerEd ||
      !activePeer ||
      !sessionTopic ||
      !myEdPubkeyHex ||
      !directActionRef.current
    ) {
      return
    }
    const requestTab = activeTab
    const requestSessionTopic = sessionTopic
    const recipientEdPubkeyHex = activePeerEd
    const recipientPeerId = activePeer.peerId
    const action = directActionRef.current
    const generation = ++directSendGenerationRef.current
    directSendingRef.current = true
    setDraft('')
    setDirectSending(true)

    const requestIsCurrent = () => {
      if (directSendGenerationRef.current !== generation) return false
      const session = useSessionStore.getState()
      return (
        session.sessionTopic === requestSessionTopic &&
        directMessagesAllowedNow() &&
        session.peers[recipientPeerId]?.edPubkeyHex === recipientEdPubkeyHex
      )
    }

    try {
      const payload = await buildDirectMessagePayload({
        sessionTopic: requestSessionTopic,
        myEdPubkeyHex,
        recipientEdPubkeyHex,
        text,
        sign: signWithKeyring,
      })
      if (!requestIsCurrent()) return
      await sendDirectMessageToPeer(action, payload, recipientPeerId)
      if (!requestIsCurrent()) return
      setDirectMessages((current) => ({
        ...current,
        [recipientEdPubkeyHex]: [
          ...(current[recipientEdPubkeyHex] ?? []),
          {
            id: payload.sig,
            mine: true,
            text: payload.text,
            ts: payload.ts,
          },
        ].slice(-MAX_DIRECT_THREAD_MESSAGES),
      }))
    } catch {
      if (!requestIsCurrent()) return
      toast.error(copy.directMessageSendFailed)
      if (activeTabRef.current === requestTab) {
        setDraft((current) => (current.length === 0 ? text : current))
      }
    } finally {
      if (directSendGenerationRef.current === generation) {
        directSendingRef.current = false
        setDirectSending(false)
      }
    }
  }

  const submitAi = async () => {
    const text = draft.trim()
    if (!text || !activeModelId || aiSendingRef.current) return
    const generation = ++aiRequestGenerationRef.current
    const requestSessionTopic = sessionTopic
    const controller = new AbortController()
    aiAbortRef.current?.abort()
    aiAbortRef.current = controller
    aiSendingRef.current = true
    const userMessage: AiDisplayMessage = {
      id: `user:${generation}:${Date.now()}`,
      role: 'user',
      content: text.slice(0, SESSION_CHAT_MAX_MESSAGE_LENGTH),
    }
    const history = aiMessages
      .filter((message) => !message.failed)
      .map(({ role, content }) => ({ role, content }))
    setAiMessages((current) =>
      [...current, userMessage].slice(-MAX_AI_THREAD_MESSAGES)
    )
    setDraft('')
    setAiSending(true)

    const requestIsCurrent = () =>
      !controller.signal.aborted &&
      aiRequestGenerationRef.current === generation &&
      useSessionStore.getState().sessionTopic === requestSessionTopic

    try {
      const replyText = await handleSessionChatText({
        text,
        declaredTopic: declaredStudyTopic,
        modelId: activeModelId,
        recentAuditKinds: auditEvents
          .slice(-SESSION_CHAT_MAX_AUDIT_CONTEXT)
          .reverse()
          .map((event) => event.kind),
        history,
        signal: controller.signal,
      })
      if (!requestIsCurrent()) return
      setAiMessages((current) =>
        [
          ...current,
          {
            id: `assistant:${generation}:${Date.now()}`,
            role: 'assistant' as const,
            content: replyText,
          },
        ].slice(-MAX_AI_THREAD_MESSAGES)
      )
    } catch (error) {
      if (!requestIsCurrent()) return
      setAiMessages((current) =>
        [
          ...current.map((message) =>
            message.id === userMessage.id
              ? { ...message, failed: true }
              : message
          ),
          {
            id: `assistant-error:${generation}:${Date.now()}`,
            role: 'assistant' as const,
            content: aiErrorCopy(error),
            failed: true,
          },
        ].slice(-MAX_AI_THREAD_MESSAGES)
      )
    } finally {
      if (aiRequestGenerationRef.current === generation) {
        aiAbortRef.current = null
        aiSendingRef.current = false
        setAiSending(false)
      }
    }
  }

  const submit = () => {
    if (activeTab === 'group') submitGroup()
    else if (activeTab === 'ai') void submitAi()
    else void submitDirectMessage()
  }

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    stopResizeRef.current?.()
    const startY = event.clientY
    const startHeight = panelHeight
    const onMove = (moveEvent: PointerEvent) => {
      setPanelHeight(
        Math.min(
          MAX_PANEL_HEIGHT,
          Math.max(MIN_PANEL_HEIGHT, startHeight + startY - moveEvent.clientY)
        )
      )
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      stopResizeRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    stopResizeRef.current = stop
  }

  const tabLabel = (tab: ChatTab) => {
    if (tab === 'group') return copy.group
    if (tab === 'ai') return copy.ai
    const key = tab.slice(3)
    return peerByEd.get(key)?.displayName ?? key.slice(0, 8)
  }

  const panelId = `${headingId}-panel`
  const tabId = (tab: ChatTab) => `${headingId}-tab-${tab.replace(':', '-')}`
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).getAttribute('role') !== 'tab') return
    const currentIndex = openTabs.indexOf(activeTab)
    if (currentIndex < 0) return
    let nextIndex: number
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % openTabs.length
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + openTabs.length) % openTabs.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = openTabs.length - 1
    } else {
      return
    }
    event.preventDefault()
    const nextTab = openTabs[nextIndex]
    setActiveTab(nextTab)
    requestAnimationFrame(() =>
      document.getElementById(tabId(nextTab))?.focus()
    )
  }

  const inputPlaceholder =
    activeTab === 'group'
      ? noteCopy.placeholder
      : activeTab === 'ai'
        ? copy.aiPlaceholder
        : copy.dmPlaceholder
  const activePeerLabel = activePeer
    ? (activePeer.displayName ?? activePeer.edPubkeyHex.slice(0, 8))
    : null
  const inputAriaLabel =
    activeTab === 'group'
      ? noteCopy.inputAriaLabel
      : activeTab === 'ai'
        ? copy.aiInputAriaLabel
        : activePeerLabel
          ? copy.dmInputAriaLabel(activePeerLabel)
          : copy.dmPlaceholder
  const sendAriaLabel =
    activeTab === 'group'
      ? noteCopy.sendAriaLabel
      : activeTab === 'ai'
        ? copy.sendAiAriaLabel
        : activePeerLabel
          ? copy.sendDirectAriaLabel(activePeerLabel)
          : copy.sendDirectFallbackAriaLabel
  const inputDisabled =
    (activeTab === 'ai' && !aiAvailable) ||
    (activeTab.startsWith('dm:') && (!showDirectMessageOptions || !activePeer))
  const sendDisabled =
    inputDisabled ||
    (activeTab === 'ai' && aiSending) ||
    (activeTab.startsWith('dm:') && directSending)

  return (
    <section
      aria-labelledby={headingId}
      className="relative flex shrink-0 flex-col border-l border-t border-border-subtle bg-bg-surface"
      style={{ height: panelHeight }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={copy.resize}
        aria-valuemin={MIN_PANEL_HEIGHT}
        aria-valuemax={MAX_PANEL_HEIGHT}
        aria-valuenow={panelHeight}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          event.preventDefault()
          setPanelHeight((current) =>
            Math.min(
              MAX_PANEL_HEIGHT,
              Math.max(
                MIN_PANEL_HEIGHT,
                current + (event.key === 'ArrowUp' ? 24 : -24)
              )
            )
          )
        }}
        className="absolute -top-2 left-0 z-10 flex h-4 w-full cursor-row-resize items-center justify-center outline-none focus-visible:ring-3 focus-visible:ring-accent-ring"
      >
        <GripHorizontalIcon className="size-4 rounded bg-bg-surface text-text-muted" />
      </div>

      <header className="flex items-center gap-2 border-b border-border-subtle px-2 py-2">
        <h2 id={headingId} className="sr-only">
          {copy.heading}
        </h2>
        <div
          role="tablist"
          aria-label={copy.conversations}
          onKeyDown={handleTabKeyDown}
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto overscroll-x-contain"
        >
          {openTabs.map((tab) => {
            const selected = tab === activeTab
            const label = tabLabel(tab)
            return (
              <div
                key={tab}
                data-chat-tab={tab}
                className={
                  selected
                    ? 'flex min-w-20 flex-1 items-center rounded-md bg-bg-sunk ring-1 ring-border-default'
                    : 'flex min-w-20 flex-1 items-center rounded-md hover:bg-bg-sunk'
                }
              >
                <button
                  type="button"
                  role="tab"
                  id={tabId(tab)}
                  aria-controls={panelId}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab)}
                  className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium text-text-primary outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-accent-ring"
                >
                  {tab === 'group' ? (
                    <MessageCircleIcon className="size-3.5 shrink-0" />
                  ) : tab === 'ai' ? (
                    <BotIcon className="size-3.5 shrink-0" />
                  ) : (
                    <UserIcon className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{label}</span>
                </button>
                {tab !== 'group' && (
                  <button
                    type="button"
                    onClick={() => closeTab(tab)}
                    aria-label={copy.close(label)}
                    className="mr-1 rounded p-1 text-text-muted outline-none hover:text-text-primary focus-visible:ring-3 focus-visible:ring-accent-ring"
                  >
                    <XIcon className="size-3" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={copy.addConversation}
            >
              <PlusIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{copy.conversations}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => openTab('ai')}>
              <BotIcon />
              <span className="flex flex-col">
                <span>{copy.ai}</span>
                <span className="text-xs font-normal text-text-muted">
                  {copy.aiDescription}
                </span>
              </span>
            </DropdownMenuItem>
            {showDirectMessageOptions && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{copy.directMessages}</DropdownMenuLabel>
                {peerList.map((peer) => (
                  <DropdownMenuItem
                    key={peer.edPubkeyHex}
                    onSelect={() => openTab(`dm:${peer.edPubkeyHex}`)}
                  >
                    <UserIcon />
                    {peer.displayName ?? peer.edPubkeyHex.slice(0, 8)}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div
        ref={scrollRef}
        tabIndex={0}
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(activeTab)}
        className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        {activeTab === 'group' ? (
          groupEntries.length === 0 ? (
            <p className="px-4 py-3 text-xs text-text-muted">
              {noteCopy.empty}
            </p>
          ) : (
            <ul
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              className="flex flex-col gap-1 px-4 py-2"
            >
              {groupEntries.map((entry) => (
                <li key={entry.id} className="text-sm leading-snug">
                  <span
                    className={
                      entry.mine
                        ? 'font-medium text-text-secondary'
                        : 'font-medium text-accent-default'
                    }
                  >
                    {resolveName(entry)}
                  </span>{' '}
                  {'text' in entry ? (
                    <span className="whitespace-pre-wrap break-words text-text-primary">
                      {entry.text}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpenImage(entry)}
                      className="mt-1 block w-full overflow-hidden rounded-md border border-border-subtle bg-bg-sunk text-left outline-none focus-visible:ring-3 focus-visible:ring-accent-ring"
                      aria-label={imageCopy.openImage(resolveName(entry))}
                    >
                      {reduceMotion && entry.frameCount > 1 ? (
                        <span className="flex min-h-24 items-center justify-center px-3 text-center text-xs text-text-secondary">
                          {entry.filename}
                        </span>
                      ) : (
                        <img
                          src={entry.objectUrl}
                          alt={imageCopy.imageAlt(resolveName(entry))}
                          className="max-h-40 w-full object-contain"
                        />
                      )}
                      <span className="block truncate border-t border-border-subtle px-2 py-1 text-xs text-text-secondary">
                        {entry.filename}
                      </span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : activeTab === 'ai' ? (
          !aiAvailable ? (
            <p className="px-4 py-4 text-sm text-text-muted">
              {copy.aiDisabled}
            </p>
          ) : aiMessages.length === 0 ? (
            <p className="px-4 py-4 text-sm text-text-muted">{copy.aiEmpty}</p>
          ) : (
            <ul role="log" aria-live="polite" className="space-y-2 px-3 py-3">
              {aiMessages.map((message) => (
                <li
                  key={message.id}
                  className={
                    message.role === 'user'
                      ? 'ml-8 rounded-lg bg-bg-sunk px-3 py-2 text-sm text-text-primary'
                      : message.failed
                        ? 'mr-8 rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-sm text-text-primary'
                        : 'mr-8 rounded-lg border border-border-default bg-bg-raised px-3 py-2 text-sm text-text-primary'
                  }
                >
                  <span className="mb-1 block text-xs font-medium text-text-secondary">
                    {message.role === 'user' ? copy.you : copy.ai}
                  </span>
                  <span className="whitespace-pre-wrap break-words">
                    {message.content}
                  </span>
                </li>
              ))}
              {aiSending && (
                <li className="mr-8 rounded-lg border border-border-default bg-bg-raised px-3 py-2 text-sm text-text-muted">
                  <span className="mb-1 block text-xs font-medium text-text-secondary">
                    {copy.ai}
                  </span>
                  {copy.thinking}
                </li>
              )}
            </ul>
          )
        ) : !activePeer ? (
          <p className="px-4 py-4 text-sm text-text-muted">
            {copy.peerUnavailable}
          </p>
        ) : activeDirectMessages.length === 0 ? (
          <p className="px-4 py-4 text-sm text-text-muted">{copy.dmEmpty}</p>
        ) : (
          <ul role="log" aria-live="polite" className="space-y-2 px-3 py-3">
            {activeDirectMessages.map((message) => (
              <li
                key={message.id}
                className={
                  message.mine
                    ? 'ml-8 rounded-lg bg-bg-sunk px-3 py-2 text-sm text-text-primary'
                    : 'mr-8 rounded-lg border border-border-default bg-bg-raised px-3 py-2 text-sm text-text-primary'
                }
              >
                <span className="mb-1 block text-xs font-medium text-text-secondary">
                  {message.mine
                    ? copy.you
                    : (activePeer.displayName ??
                      activePeer.edPubkeyHex.slice(0, 8))}
                </span>
                <span className="whitespace-pre-wrap break-words">
                  {message.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        className="flex items-center gap-2 border-t border-border-subtle px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {activeTab === 'group' && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) onSendImage(file)
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              aria-label={imageCopy.attachImage}
            >
              <ImagePlusIcon />
            </Button>
          </>
        )}
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={inputPlaceholder}
          aria-label={inputAriaLabel}
          maxLength={
            activeTab === 'group'
              ? NOTE_MAX_LENGTH
              : activeTab === 'ai'
                ? SESSION_CHAT_MAX_MESSAGE_LENGTH
                : DIRECT_MESSAGE_MAX_LENGTH
          }
          disabled={inputDisabled}
          className="h-8 text-sm"
        />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={sendDisabled || draft.trim().length === 0}
          aria-label={sendAriaLabel}
        >
          <SendIcon />
        </Button>
      </form>
    </section>
  )
}
