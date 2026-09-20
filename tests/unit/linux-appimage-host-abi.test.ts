import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe.skipIf(process.platform !== 'linux')(
  'AppImage host Wayland boundary',
  () => {
    let fixture: string
    let appdir: string
    let wrapper: string

    beforeEach(() => {
      fixture = mkdtempSync(join(tmpdir(), 'studyvis-host-abi-'))
      appdir = join(fixture, 'StudyVis.AppDir')
      mkdirSync(join(appdir, 'usr', 'lib'), { recursive: true })
      wrapper = join(fixture, 'linuxdeploy-plugin-appimage.AppImage')
      copyFileSync(resolve('scripts/linuxdeploy-plugin-appimage.sh'), wrapper)
      // Archive generation is external; leave all filesystem policy in the real wrapper.
      writeFileSync(
        join(fixture, 'studyvis-appimage-output.AppImage'),
        '#!/usr/bin/env bash\nif [[ $1 == --plugin-type ]]; then echo output; fi\nexit "${STUDYVIS_TEST_OUTPUT_STATUS:-0}"\n',
        { mode: 0o755 }
      )
    })

    afterEach(() => rmSync(fixture, { recursive: true, force: true }))

    function run(...args: string[]) {
      return spawnSync('bash', [wrapper, ...args], { encoding: 'utf8' })
    }

    it('removes the bundled client while preserving private WebKit and other Wayland libraries', () => {
      const libdir = join(appdir, 'usr', 'lib')
      writeFileSync(join(libdir, 'libwayland-client.so.0'), 'old client')
      writeFileSync(
        join(libdir, 'libwebkit2gtk-4.1.so.0'),
        'private WebRTC WebKit'
      )
      writeFileSync(join(libdir, 'libwayland-server.so.0'), 'server')

      expect(run('--appdir', appdir).status).toBe(0)
      expect(existsSync(join(libdir, 'libwayland-client.so.0'))).toBe(false)
      expect(readFileSync(join(libdir, 'libwebkit2gtk-4.1.so.0'), 'utf8')).toBe(
        'private WebRTC WebKit'
      )
      expect(readFileSync(join(libdir, 'libwayland-server.so.0'), 'utf8')).toBe(
        'server'
      )
    })

    it('removes versioned aliases in nested library directories without following their targets', () => {
      const libdir = join(appdir, 'usr', 'lib', 'x86_64-linux-gnu')
      mkdirSync(libdir)
      const outside = join(fixture, 'host-client')
      writeFileSync(outside, 'host driver client')
      symlinkSync(outside, join(libdir, 'libwayland-client.so.0'))
      writeFileSync(join(libdir, 'libwayland-client.so.0.22.0'), 'old client')

      expect(run(`--appdir=${appdir}`).status).toBe(0)
      expect(() => lstatSync(join(libdir, 'libwayland-client.so.0'))).toThrow()
      expect(existsSync(join(libdir, 'libwayland-client.so.0.22.0'))).toBe(
        false
      )
      expect(readFileSync(outside, 'utf8')).toBe('host driver client')
    })

    it('refuses a symlinked library root instead of deleting outside the AppDir', () => {
      const outside = join(fixture, 'system-lib')
      mkdirSync(outside)
      writeFileSync(
        join(outside, 'libwayland-client.so.0'),
        'host driver client'
      )
      rmSync(join(appdir, 'usr', 'lib'), { recursive: true })
      symlinkSync(outside, join(appdir, 'usr', 'lib'))

      expect(run('--appdir', appdir).status).not.toBe(0)
      expect(
        readFileSync(join(outside, 'libwayland-client.so.0'), 'utf8')
      ).toBe('host driver client')
    })

    it('refuses a symlinked usr directory', () => {
      const outside = join(fixture, 'system-usr')
      mkdirSync(join(outside, 'lib'), { recursive: true })
      writeFileSync(
        join(outside, 'lib', 'libwayland-client.so.0'),
        'host driver client'
      )
      rmSync(join(appdir, 'usr'), { recursive: true })
      symlinkSync(outside, join(appdir, 'usr'))

      expect(run('--appdir', appdir).status).not.toBe(0)
      expect(
        readFileSync(join(outside, 'lib', 'libwayland-client.so.0'), 'utf8')
      ).toBe('host driver client')
    })

    it('refuses an AppDir symlink even when the input has trailing slashes', () => {
      const alias = join(fixture, 'selected.AppDir')
      symlinkSync(appdir, alias)
      const client = join(appdir, 'usr', 'lib', 'libwayland-client.so.0')
      writeFileSync(client, 'other artifact client')

      expect(run('--appdir', `${alias}///`).status).not.toBe(0)
      expect(readFileSync(client, 'utf8')).toBe('other artifact client')
    })

    it('rejects a directory that is not an AppDir', () => {
      expect(run('--appdir', fixture).status).not.toBe(0)
    })

    it('answers plugin discovery without requiring an AppDir', () => {
      const result = run('--plugin-type')
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('output')
    })

    it('preserves failures reported by the pinned output tool', () => {
      const result = spawnSync('bash', [wrapper, '--appdir', appdir], {
        encoding: 'utf8',
        env: { ...process.env, STUDYVIS_TEST_OUTPUT_STATUS: '27' },
      })
      expect(result.status).toBe(27)
    })
  }
)
