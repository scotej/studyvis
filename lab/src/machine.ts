// One lab machine: its own Chrome process, its own workdir, its own backend.
//
// A machine is deliberately a whole browser rather than a browser context.
// Contexts share a network stack and one set of command-line switches, so two
// "machines" in one browser could not be given different fake cameras, and
// their WebRTC would share more than two real installs do. A process each is a
// closer model of what the app will actually meet.

import { mkdirSync } from 'node:fs'

import { chromium, type Browser, type Page } from 'playwright-core'

import { LabBackend } from './backend/index'
import { installBridge, type BridgeConfig } from './bridge/initScript'

export type MachineMedia = {
  /** Y4M file played as the webcam. Chrome loops it. */
  videoFile?: string
  /** WAV file played as the microphone. */
  audioFile?: string
}

export type MachineOptions = {
  name: string
  workdir: string
  appUrl: string
  websocketRewrites: Record<string, string>
  allowedOrigins: string[]
  headless: boolean
  media?: MachineMedia
  clockSkewMs?: number
  /** Written into settings.json before the app boots. */
  settings?: Record<string, unknown>
  /** Written into app-state.json before the app boots (onboarding state). */
  appState?: Record<string, unknown>
  chromeChannel?: string
  chromeExecutable?: string
}

export type PageError = { ts: number; label: string; message: string }

export class LabMachine {
  readonly name: string
  readonly backend: LabBackend
  readonly pages = new Map<string, Page>()
  readonly pageErrors: PageError[] = []
  readonly consoleErrors: PageError[] = []
  readonly blockedRequests: string[] = []

  private browser!: Browser
  private readonly options: MachineOptions

  private constructor(options: MachineOptions) {
    this.name = options.name
    this.options = options
    mkdirSync(options.workdir, { recursive: true })
    this.backend = new LabBackend({
      name: options.name,
      dir: options.workdir,
      emit: (event, payload, label) => {
        void this.emit(event, payload, label)
      },
    })
  }

  static async start(options: MachineOptions): Promise<LabMachine> {
    const machine = new LabMachine(options)
    await machine.boot()
    return machine
  }

  private async boot(): Promise<void> {
    const { options } = this
    if (options.settings) {
      this.backend.stores.seed('settings.json', options.settings)
    }
    if (options.appState) {
      this.backend.stores.seed('app-state.json', options.appState)
    }

    const args = [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // getDisplayMedia otherwise opens a picker no automation can answer.
      '--auto-select-desktop-capture-source=Entire screen',
      // Two peers on one machine must not be pushed onto mDNS-obfuscated
      // candidates; host candidates are what makes the loopback path work.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ]
    if (options.media?.videoFile) {
      args.push(`--use-file-for-fake-video-capture=${options.media.videoFile}`)
    }
    if (options.media?.audioFile) {
      args.push(`--use-file-for-fake-audio-capture=${options.media.audioFile}`)
    }

    this.browser = await chromium.launch({
      headless: options.headless,
      args,
      ...(options.chromeExecutable
        ? { executablePath: options.chromeExecutable }
        : { channel: options.chromeChannel ?? 'chrome' }),
    })

    await this.openPage('main', options.appUrl)
  }

  /** Opens one of the app's webview windows as a page of this machine. */
  async openPage(label: string, url: string): Promise<Page> {
    const existing = this.pages.get(label)
    if (existing) return existing

    const context = await this.browser.newContext({
      permissions: ['camera', 'microphone'],
      viewport: { width: 1280, height: 800 },
    })

    await context.exposeBinding(
      '__labInvoke',
      async (_source, cmd: string, args: unknown) =>
        this.backend.invoke(cmd, args)
    )

    const config: BridgeConfig = {
      label,
      websocketRewrites: this.options.websocketRewrites,
      allowedOrigins: this.options.allowedOrigins,
      clockSkewMs: this.options.clockSkewMs ?? 0,
    }
    // Serialized by hand rather than via `addInitScript(fn, arg)`: the
    // transpiler wraps declarations in its own `__name` helper, which does not
    // exist in the page and throws before a single line of the bridge runs.
    await context.addInitScript({
      content: `globalThis.__name ??= (fn) => fn;\n(${installBridge.toString()})(${JSON.stringify(config)});`,
    })

    // Belt to the WebSocket patch's braces: HTTP egress is refused at the
    // network layer, where an app-level patch cannot reach (fonts, images, a
    // stray fetch). Together they are what lets `lab doctor` assert the run
    // never left the machine.
    await context.route('**/*', (route) => {
      const url_ = route.request().url()
      if (isAllowed(url_, this.options.allowedOrigins)) {
        void route.continue()
        return
      }
      this.blockedRequests.push(url_)
      void route.abort('blockedbyclient')
    })

    const page = await context.newPage()
    page.on('pageerror', (error) => {
      this.pageErrors.push({
        ts: Date.now(),
        label,
        message: String(error).slice(0, 2000),
      })
    })
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      this.consoleErrors.push({
        ts: Date.now(),
        label,
        message: message.text().slice(0, 2000),
      })
    })

    this.pages.set(label, page)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return page
  }

  page(label = 'main'): Page {
    const page = this.pages.get(label)
    if (!page) {
      throw new Error(
        `lab: machine '${this.name}' has no window '${label}' (have: ${[...this.pages.keys()].join(', ')})`
      )
    }
    return page
  }

  /** Push a Tauri event into this machine's windows, as Rust would. */
  async emit(event: string, payload: unknown, label?: string): Promise<number> {
    let delivered = 0
    for (const [pageLabel, page] of this.pages) {
      if (label !== undefined && label !== pageLabel) continue
      if (page.isClosed()) continue
      try {
        delivered += await page.evaluate(
          ([e, p]) =>
            (
              window as unknown as {
                __lab: { deliver: (event: string, payload: unknown) => number }
              }
            ).__lab.deliver(e as string, p),
          [event, payload] as [string, unknown]
        )
      } catch {
        // A page navigating while an event lands is not an error worth failing
        // a scenario over; the app's own listeners are re-registered on load.
      }
    }
    return delivered
  }

  async close(): Promise<void> {
    this.backend.close()
    await this.browser?.close()
  }
}

function isAllowed(url: string, allowedOrigins: string[]): boolean {
  if (
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('about:')
  ) {
    return true
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
    return true
  }
  return allowedOrigins.some((origin) => url.startsWith(origin))
}
