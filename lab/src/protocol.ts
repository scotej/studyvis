// Wire types and paths shared by the daemon and its clients. Kept apart from
// daemon.ts because that module starts a lab the moment it is imported.

import path from 'node:path'

import { WORK_ROOT } from './lab'

export const SOCKET_PATH = path.join(WORK_ROOT, 'daemon.sock')
export const META_PATH = path.join(WORK_ROOT, 'daemon.json')

export type Request = {
  id: number
  command: string
  args: Record<string, unknown>
}

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
