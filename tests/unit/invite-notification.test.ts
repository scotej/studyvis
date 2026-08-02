import { describe, expect, test, vi } from 'vitest'

import { notifyIncomingInvite } from '@/features/friends/inviteNotification'

const BODY = 'Alex invites you to study'

function deps({
  granted = true,
  requested = 'granted' as NotificationPermission,
} = {}) {
  return {
    isPermissionGranted: vi.fn(async () => granted),
    requestPermission: vi.fn(async () => requested),
    sendNotification: vi.fn(),
  }
}

describe('notifyIncomingInvite', () => {
  test('sends the native notification with the invite copy', async () => {
    const notification = deps()

    await notifyIncomingInvite({ body: BODY, enabled: true }, notification)

    expect(notification.requestPermission).not.toHaveBeenCalled()
    expect(notification.sendNotification).toHaveBeenCalledOnce()
    expect(notification.sendNotification).toHaveBeenCalledWith({
      title: 'StudyVis',
      body: BODY,
    })
  })

  test('requests permission before sending when needed', async () => {
    const notification = deps({ granted: false })

    await notifyIncomingInvite({ body: BODY, enabled: true }, notification)

    expect(notification.requestPermission).toHaveBeenCalledOnce()
    expect(notification.sendNotification).toHaveBeenCalledOnce()
  })

  test('does not send when permission is denied', async () => {
    const notification = deps({ granted: false, requested: 'denied' })

    await notifyIncomingInvite({ body: BODY, enabled: true }, notification)

    expect(notification.requestPermission).toHaveBeenCalledOnce()
    expect(notification.sendNotification).not.toHaveBeenCalled()
  })

  test('does not touch the OS API when invite notifications are disabled', async () => {
    const notification = deps()

    await notifyIncomingInvite({ body: BODY, enabled: false }, notification)

    expect(notification.isPermissionGranted).not.toHaveBeenCalled()
    expect(notification.requestPermission).not.toHaveBeenCalled()
    expect(notification.sendNotification).not.toHaveBeenCalled()
  })

  test('keeps permission lookup failures non-fatal', async () => {
    const notification = deps()
    notification.isPermissionGranted.mockRejectedValue(
      new Error('notification bridge unavailable')
    )

    await expect(
      notifyIncomingInvite({ body: BODY, enabled: true }, notification)
    ).resolves.toBeUndefined()
    expect(notification.sendNotification).not.toHaveBeenCalled()
  })

  test('keeps native send failures non-fatal', async () => {
    const notification = deps()
    notification.sendNotification.mockImplementation(() => {
      throw new Error('notification daemon unavailable')
    })

    await expect(
      notifyIncomingInvite({ body: BODY, enabled: true }, notification)
    ).resolves.toBeUndefined()
  })
})
