// tauri-plugin-store, reimplemented against real files on the peer's workdir.
//
// The JS side is resource-id based: `load(path)` returns a rid and every later
// call passes it. Path-keying instead would work until two LazyStores for the
// same file diverge, so the rid table is modelled properly.
//
// settings.json is the file the app persists every user setting to, so this is
// also the seam `lab up --settings` writes through — the "control all settings
// locally" half of the harness.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type StoreFile = { file: string; values: Record<string, unknown> }

export class LabStores {
  private readonly byRid = new Map<number, StoreFile>()
  private readonly ridByPath = new Map<string, number>()
  private nextRid = 1

  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /** Write a store file directly, before the app ever boots. */
  seed(storePath: string, values: Record<string, unknown>): void {
    const file = path.join(this.dir, storePath)
    const existing = this.readFile(file)
    writeFileSync(file, JSON.stringify({ ...existing, ...values }, null, 2))
    const rid = this.ridByPath.get(storePath)
    if (rid !== undefined) {
      const entry = this.byRid.get(rid)
      if (entry) entry.values = this.readFile(file)
    }
  }

  read(storePath: string): Record<string, unknown> {
    return this.readFile(path.join(this.dir, storePath))
  }

  handle(command: string, args: Record<string, unknown>): unknown {
    switch (command) {
      case 'load': {
        const storePath = String(args.path)
        const existing = this.ridByPath.get(storePath)
        if (existing !== undefined) return existing
        const file = path.join(this.dir, storePath)
        const rid = this.nextRid++
        this.byRid.set(rid, { file, values: this.readFile(file) })
        this.ridByPath.set(storePath, rid)
        return rid
      }
      case 'get_store':
        return this.ridByPath.get(String(args.path)) ?? null
      case 'get': {
        const entry = this.entry(args)
        const key = String(args.key)
        // The plugin returns a [value, exists] tuple; `undefined` for a missing
        // key would be indistinguishable from a stored null.
        return key in entry.values ? [entry.values[key], true] : [null, false]
      }
      case 'set': {
        const entry = this.entry(args)
        entry.values[String(args.key)] = args.value
        this.flush(entry)
        return null
      }
      case 'has':
        return String(args.key) in this.entry(args).values
      case 'delete': {
        const entry = this.entry(args)
        const key = String(args.key)
        const had = key in entry.values
        delete entry.values[key]
        this.flush(entry)
        return had
      }
      case 'clear':
      case 'reset': {
        const entry = this.entry(args)
        entry.values = {}
        this.flush(entry)
        return null
      }
      case 'keys':
        return Object.keys(this.entry(args).values)
      case 'values':
        return Object.values(this.entry(args).values)
      case 'entries':
        return Object.entries(this.entry(args).values)
      case 'length':
        return Object.keys(this.entry(args).values).length
      case 'reload': {
        const entry = this.entry(args)
        entry.values = this.readFile(entry.file)
        return null
      }
      case 'save': {
        this.flush(this.entry(args))
        return null
      }
      default:
        throw new Error(`lab: unhandled plugin:store command '${command}'`)
    }
  }

  private entry(args: Record<string, unknown>): StoreFile {
    const rid = Number(args.rid)
    const entry = this.byRid.get(rid)
    if (!entry) throw new Error(`lab: no store resource ${rid}`)
    return entry
  }

  private readFile(file: string): Record<string, unknown> {
    if (!existsSync(file)) return {}
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  private flush(entry: StoreFile): void {
    writeFileSync(entry.file, JSON.stringify(entry.values, null, 2))
  }
}
