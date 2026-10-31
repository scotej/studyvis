import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createBrowserTalk,
  installBrowserTalkShortcut,
} from '@/features/mirror/browserTalk'
import { DEFAULT_PTT_FRIENDS_COMBO, type Combo } from '@/lib/keybindings'
import { MAX_HOLD_MS } from '@/stores/pttStore'

afterEach(() => vi.useRealTimers())

describe('browser microphone intent', () => {
  test('defaults muted and overlapping holds require their own releases', () => {
    const changed = vi.fn()
    const talk = createBrowserTalk(changed)
    expect(talk.getState()).toEqual({
      held: false,
      microphoneOpen: false,
      active: false,
    })
    talk.press()
    talk.press('shortcut')
    talk.release()
    expect(talk.getState().active).toBe(true)
    talk.release('shortcut')
    expect(talk.getState().active).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
    talk.reset()
  })

  test('blur releases temporary holds and preserves explicit open microphone', () => {
    const talk = createBrowserTalk(vi.fn())
    talk.setMicrophoneOpen(true)
    talk.press()
    talk.blur()
    expect(talk.getState()).toEqual({
      held: false,
      microphoneOpen: true,
      active: true,
    })
    talk.setMicrophoneOpen(false)
    expect(talk.getState().active).toBe(false)
    talk.reset()
  })

  test('hold blur never resumes audio without a fresh press', () => {
    const talk = createBrowserTalk(vi.fn())
    talk.press()
    talk.blur()
    expect(talk.getState().active).toBe(false)
    talk.release()
    expect(talk.getState().active).toBe(false)
    talk.press()
    expect(talk.getState().active).toBe(true)
    talk.reset()
  })

  test('session/disconnect reset clears explicit microphone intent and all holds', () => {
    const talk = createBrowserTalk(vi.fn())
    talk.setMicrophoneOpen(true)
    talk.press()
    talk.reset()
    talk.release()
    expect(talk.getState()).toEqual({
      held: false,
      microphoneOpen: false,
      active: false,
    })
  })

  test('stuck hold times out without repeats renewing it or reopening it', () => {
    vi.useFakeTimers()
    const talk = createBrowserTalk(vi.fn())
    talk.press()
    vi.advanceTimersByTime(MAX_HOLD_MS - 1)
    talk.press()
    vi.advanceTimersByTime(1)
    expect(talk.getState().active).toBe(false)
    talk.press()
    talk.press('shortcut')
    expect(talk.getState().active).toBe(false)
    talk.release()
    talk.release('shortcut')
    talk.press()
    expect(talk.getState().active).toBe(true)
    talk.reset()
  })

  test('hold cutoff does not silently mute an explicitly opened microphone', () => {
    vi.useFakeTimers()
    const talk = createBrowserTalk(vi.fn())
    talk.setMicrophoneOpen(true)
    talk.press()
    vi.advanceTimersByTime(MAX_HOLD_MS)
    expect(talk.getState()).toEqual({
      held: false,
      microphoneOpen: true,
      active: true,
    })
    talk.reset()
  })
})

function shortcutFixture(
  platform: 'mac' | 'other' = 'other',
  combo: Combo = DEFAULT_PTT_FRIENDS_COMBO
) {
  const target = new EventTarget()
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    hasFocus: vi.fn(() => true),
    activeElement: { closest: vi.fn(() => null) },
    querySelector: vi.fn(() => null),
  })
  const talk = createBrowserTalk(vi.fn())
  const enabled = vi.fn(() => true)
  const dispose = installBrowserTalkShortcut({
    target: target as Window,
    document: document as unknown as Document,
    talk,
    combo,
    platform,
    enabled,
  })
  const key = (type: string, values: Partial<KeyboardEvent> = {}) => {
    const event = new Event(type, { cancelable: true })
    Object.defineProperties(
      event,
      Object.fromEntries(
        Object.entries({
          code: 'BracketLeft',
          ctrlKey: platform === 'other',
          metaKey: platform === 'mac',
          altKey: false,
          shiftKey: false,
          isComposing: false,
          repeat: false,
          ...values,
        }).map(([key, value]) => [key, { value }])
      )
    )
    target.dispatchEvent(event)
    return event
  }
  return { target, document, talk, enabled, dispose, key }
}

describe('browser foreground push-to-talk shortcut', () => {
  test('supports a host binding using explicit Control on Windows/Linux', () => {
    const fixture = shortcutFixture('other', {
      ...DEFAULT_PTT_FRIENDS_COMBO,
      mod: false,
      ctrl: true,
    })
    fixture.key('keydown')
    expect(fixture.talk.getState().held).toBe(true)
    fixture.dispose()
  })

  test.each(['mac', 'other'] as const)(
    'handles the actual binding on %s and releases when its modifier is released first',
    (platform) => {
      const fixture = shortcutFixture(platform)
      expect(fixture.key('keydown').defaultPrevented).toBe(true)
      expect(fixture.talk.getState().held).toBe(true)
      fixture.key('keyup', {
        code: platform === 'mac' ? 'MetaLeft' : 'ControlLeft',
      })
      expect(fixture.talk.getState().held).toBe(false)
      fixture.dispose()
    }
  )

  test('ignores editable controls, open modals, composition, repeats and wrong shortcuts', () => {
    const fixture = shortcutFixture()
    fixture.document.activeElement.closest.mockReturnValueOnce({} as never)
    fixture.key('keydown')
    fixture.document.querySelector.mockReturnValueOnce({} as never)
    fixture.key('keydown')
    fixture.key('keydown', { isComposing: true })
    fixture.key('keydown', { repeat: true })
    fixture.key('keydown', { code: 'KeyK' })
    fixture.key('keydown', { shiftKey: true })
    fixture.key('keydown', { metaKey: true })
    expect(fixture.talk.getState().held).toBe(false)
    fixture.dispose()
  })

  test('refuses background/unfocused/disabled key input and clears holds on focus loss', () => {
    const fixture = shortcutFixture()
    fixture.document.visibilityState = 'hidden'
    fixture.key('keydown')
    fixture.document.visibilityState = 'visible'
    fixture.document.hasFocus.mockReturnValueOnce(false)
    fixture.key('keydown')
    fixture.enabled.mockReturnValueOnce(false)
    fixture.key('keydown')
    expect(fixture.talk.getState().held).toBe(false)
    fixture.key('keydown')
    expect(fixture.talk.getState().held).toBe(true)
    fixture.target.dispatchEvent(new Event('blur'))
    expect(fixture.talk.getState().held).toBe(false)
    fixture.key('keydown')
    fixture.document.visibilityState = 'hidden'
    fixture.document.dispatchEvent(new Event('visibilitychange'))
    expect(fixture.talk.getState().held).toBe(false)
    fixture.dispose()
  })

  test('keyup while editing still releases and disposal prevents further activation', () => {
    const fixture = shortcutFixture()
    fixture.key('keydown')
    fixture.document.activeElement.closest.mockReturnValueOnce({} as never)
    fixture.key('keyup')
    expect(fixture.talk.getState().held).toBe(false)
    fixture.dispose()
    fixture.key('keydown')
    expect(fixture.talk.getState().held).toBe(false)
  })
})
