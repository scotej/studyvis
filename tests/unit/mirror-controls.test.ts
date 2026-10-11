import { describe, expect, test } from 'vitest'

import { parseMirrorControl } from '@/features/mirror/sessionBridge'

describe('paired-browser session authority', () => {
  test('permits session controls and canonicalizes public friend identifiers', () => {
    expect(parseMirrorControl({ type: 'ptt', active: false })).toEqual({
      type: 'ptt',
      active: false,
    })
    expect(
      parseMirrorControl({ type: 'topic', topic: '  Chapter three  ' })
    ).toEqual({ type: 'topic', topic: 'Chapter three' })
    expect(
      parseMirrorControl({
        type: 'direct_message',
        recipient: 'AB'.repeat(32),
        text: 'Ready?',
      })
    ).toEqual({
      type: 'direct_message',
      recipient: 'ab'.repeat(32),
      text: 'Ready?',
    })
    expect(
      parseMirrorControl({
        type: 'pomodoro_start',
        args: { preset: 'custom', workMs: 300_000, restMs: 60_000 },
      })
    ).toEqual({
      type: 'pomodoro_start',
      args: { preset: 'custom', workMs: 300_000, restMs: 60_000 },
    })
  })

  test.each([
    { type: 'identity_sign', message: [1] },
    { type: 'identity_save_keys', edPrivHex: 'secret' },
    { type: 'system_write_text_file', path: '/somewhere', contents: 'data' },
    { type: 'model_download', url: 'https://example.com/model' },
    { type: 'sidecar_start', modelPath: '/a-model' },
    { type: 'ptt', active: 'true' },
    { type: 'topic', topic: '   ' },
    { type: 'note', text: 'x'.repeat(501) },
    { type: 'direct_message', recipient: '../identity', text: 'x' },
    { type: 'break', durationSec: 1.5 },
    { type: 'break', durationSec: 1801 },
    { type: 'image', filename: 'f', mimeType: 'image/svg+xml', data: 'YQ==' },
    { type: 'image', filename: 'f', mimeType: 'image/png', data: '<svg>' },
    {
      type: 'pomodoro_start',
      args: { preset: 'custom', workMs: 299_999, restMs: 60_000 },
    },
    {
      type: 'pomodoro_start',
      args: { preset: 'custom', workMs: Infinity, restMs: 60_000 },
    },
    null,
    [],
  ])('refuses malformed input and privileged desktop actions', (control) => {
    expect(parseMirrorControl(control)).toBeNull()
  })

  test('extra fields never become a desktop command payload', () => {
    expect(
      parseMirrorControl({ type: 'dismiss_error', error: 'untrusted' })
    ).toEqual({ type: 'dismiss_error' })
    expect(
      parseMirrorControl({ type: 'leave', path: '/data', edPrivHex: 'secret' })
    ).toEqual({ type: 'leave' })
    expect(
      parseMirrorControl({
        type: 'note',
        text: 'A note',
        command: 'identity_load_keys',
      })
    ).toEqual({ type: 'note', text: 'A note' })
  })
})
