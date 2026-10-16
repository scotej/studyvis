import type { PrepareContext } from '@storybook/test-runner'
import { afterEach, describe, expect, test, vi } from 'vitest'

import config from '../../.storybook/test-runner'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function setup(onPoll?: () => void) {
  vi.stubEnv('TARGET_URL', 'http://127.0.0.1:6006/')
  vi.stubEnv('STUDYVIS_A11Y_THEME', 'light')
  let theme = 'dark'
  const globals = { get: () => ({ theme }) }
  const emit = vi.fn(
    (_event: string, payload: { globals: { theme: string } }) => {
      theme = payload.globals.theme
    }
  )
  const target: {
    __STORYBOOK_ADDONS_CHANNEL__: { emit: typeof emit }
    __STORYBOOK_PREVIEW__?: {
      ready(): Promise<void>
      readonly storyStore?: { userGlobals?: typeof globals }
    }
  } = { __STORYBOOK_ADDONS_CHANNEL__: { emit } }
  vi.stubGlobal('window', target)
  const page = {
    setViewportSize: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    waitForFunction: vi.fn(async (predicate, arg) => {
      for (let poll = 0; poll < 5; poll++) {
        const result = predicate(arg)
        if (result) return await result
        onPoll?.()
      }
      throw new Error('polling timed out')
    }),
    evaluate: vi.fn(async (callback, arg) => callback(arg)),
  }
  const prepare = () => config.prepare!({ page } as unknown as PrepareContext)
  return { globals, target, page, prepare, emit }
}

describe('Storybook accessibility setup readiness', () => {
  test('waits for preview initialization before accessing the guarded store or changing theme', async () => {
    const { globals, target, page, prepare, emit } = setup()
    let initialized = false
    let resolveReady!: () => void
    const initialization = new Promise<void>((resolve) => {
      resolveReady = () => {
        initialized = true
        resolve()
      }
    })
    const store = vi.fn(() => {
      if (!initialized)
        throw new Error('StoryStoreAccessedBeforeInitializationError')
      return { userGlobals: globals }
    })
    const ready = vi.fn(function (this: unknown) {
      expect(this).toBe(target.__STORYBOOK_PREVIEW__)
      return initialization
    })
    target.__STORYBOOK_PREVIEW__ = {
      ready,
      get storyStore() {
        return store()
      },
    }

    const pending = prepare()
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
    expect(store).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    resolveReady()
    await pending

    expect(globals.get().theme).toBe('light')
    expect(emit).toHaveBeenCalledOnce()
    expect(page.waitForFunction).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      undefined,
      { timeout: 30_000 }
    )
  })

  test('preserves initialization rejection without reading the store or emitting globals', async () => {
    const { globals, target, prepare, emit } = setup()
    const failure = new Error('failed to fetch the story index')
    const store = vi.fn(() => ({ userGlobals: globals }))
    target.__STORYBOOK_PREVIEW__ = {
      ready: async () => {
        throw failure
      },
      get storyStore() {
        return store()
      },
    }

    await expect(prepare()).rejects.toBe(failure)
    expect(store).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  test('polls while the preview is absent and initializes the theme after it appears', async () => {
    const ready = vi.fn(async () => {})
    const { globals, target, page, prepare } = setup(() => {
      target.__STORYBOOK_PREVIEW__ = {
        ready,
        storyStore: { userGlobals: globals },
      }
    })

    await prepare()
    expect(ready).toHaveBeenCalledOnce()
    expect(globals.get().theme).toBe('light')
    expect(page.waitForFunction).toHaveBeenCalledTimes(2)
  })

  test('rejects a preview that becomes ready without initializing globals', async () => {
    const { target, prepare, emit } = setup()
    target.__STORYBOOK_PREVIEW__ = {
      ready: async () => {},
      storyStore: {},
    }

    await expect(prepare()).rejects.toThrow(
      'Storybook initialized without user globals'
    )
    expect(emit).not.toHaveBeenCalled()
  })

  test('does not emit globals if the preview never appears', async () => {
    const { prepare, emit } = setup()

    await expect(prepare()).rejects.toThrow('polling timed out')
    expect(emit).not.toHaveBeenCalled()
  })
})
