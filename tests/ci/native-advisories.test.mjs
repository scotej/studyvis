import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  advisoryLinks,
  applyExceptions,
  checkNative,
  compareVersions,
  createFetcher,
  parseGstreamerAdvisory,
  parseWebkitAdvisory,
  pinnedVersion,
  releaseVersion,
} from '../../scripts/check-native-advisories.mjs'

test('numeric versions do not compare lexically or treat a newer release as a CVE', () => {
  assert.equal(compareVersions('1.28.10', '1.28.9'), 1)
  assert.equal(compareVersions('2.54.1', '2.52.5'), 1)
  assert.equal(compareVersions('1.3', '1.3.0'), 0)
  assert.throws(() => compareVersions('1.2rc1', '1.2.0'))
  assert.equal(
    releaseVersion('webkitgtk-2.54.1.tar.xz webkitgtk-2.55.90.tar.xz', {
      kind: 'directory',
      pattern: 'webkitgtk-(\\d+\\.\\d+\\.\\d+)\\.tar',
      evenMinor: true,
    }),
    '2.54.1'
  )
  assert.equal(
    releaseVersion(
      JSON.stringify([
        { tag_name: 'b99' },
        { tag_name: 'b100' },
        { tag_name: 'b101', prerelease: true },
      ]),
      { kind: 'github-releases', pattern: '^b(\\d+)$' }
    ),
    '100'
  )
})

test('WebKit advisory applies only below each documented fixed version', () => {
  const html =
    '<li><a>CVE-2026-43804</a><ul><li>Versions affected: WebKitGTK and WPE WebKit before 2.52.6.</li></ul></li><li>CVE-2026-28984 <ul><li>Versions affected: WebKitGTK before 2.52.4.</li></ul></li>We recommend updating.'
  assert.deepEqual(
    parseWebkitAdvisory(
      html,
      '2.52.5',
      'https://webkitgtk.org/security/WSA-2026-0005.html'
    ).map((finding) => finding.id),
    ['CVE-2026-43804']
  )
  assert.deepEqual(
    parseWebkitAdvisory(
      html,
      '2.52.6',
      'https://webkitgtk.org/security/WSA-2026-0005.html'
    ),
    []
  )
  assert.throws(
    () =>
      parseWebkitAdvisory(
        html.replaceAll('before', 'unknown range'),
        '2.52.5',
        'url'
      ),
    /unrecognized affected/
  )
})

test('GStreamer HTML range parsing does not call patched versions affected', () => {
  const html =
    '<table><tr><th>Affected Versions</th><td>GStreamer gst-plugins-bad &lt; 1.28.8</td></tr><tr><th>IDs</th><td>GStreamer-SA-2026-0092</td></tr></table>'
  assert.equal(
    parseGstreamerAdvisory(html, '1.28.7', 'url')[0].fixedVersion,
    '1.28.8'
  )
  assert.deepEqual(parseGstreamerAdvisory(html, '1.28.8', 'url'), [])
  assert.throws(
    () =>
      parseGstreamerAdvisory(html.replace('&lt;', 'unknown'), '1.28.7', 'url'),
    /unrecognized affected/
  )
})

test('GStreamer excludes unbundled source modules and keeps built-module candidates', () => {
  const page = (module) =>
    `<th>Affected Versions</th><td>GStreamer ${module} &lt; 1.28.8</td><th>IDs</th><td>GStreamer-SA-2026-0090</td>`
  for (const module of [
    'gst-editing-services',
    'Editing Services',
    'gst-rtsp-server',
    'gst-libav',
    'Orc',
    'gst-plugins-ugly',
  ]) {
    const records = parseGstreamerAdvisory(page(module), '1.28.7', 'url')
    assert.equal(records[0].kind, 'excluded')
    assert.match(records[0].reason, /absent from the pinned/)
  }
  assert.equal(
    parseGstreamerAdvisory(page('gst-plugins-good'), '1.28.7', 'url')[0].kind,
    'advisory'
  )
})

test('fixed versions respect maintained branches and explicit introduced ranges', () => {
  const gst = (range) =>
    `Affected Versions GStreamer gst-plugins-bad ${range} IDs GStreamer-SA-2026-0001 Details text`
  assert.deepEqual(
    parseGstreamerAdvisory(gst('&lt; 1.24.15, &lt; 1.26.3'), '1.24.15', 'url'),
    []
  )
  assert.equal(
    parseGstreamerAdvisory(gst('&lt; 1.24.15, &lt; 1.26.3'), '1.26.2', 'url')[0]
      .fixedVersion,
    '1.26.3'
  )
  const introduced = gst(
    '&gt;= 1.24.0, &lt; 1.24.15 or &gt;= 1.26.0, &lt; 1.26.3'
  )
  assert.deepEqual(parseGstreamerAdvisory(introduced, '1.25.0', 'url'), [])
  assert.equal(
    parseGstreamerAdvisory(introduced, '1.26.2', 'url')[0].fixedVersion,
    '1.26.3'
  )
  const webkit =
    'CVE-2026-12345 Versions affected: WebKitGTK before 2.50.7 or 2.52.1. We recommend updating.'
  assert.deepEqual(parseWebkitAdvisory(webkit, '2.50.7', 'url'), [])
  assert.equal(
    parseWebkitAdvisory(webkit, '2.52.0', 'url')[0].fixedVersion,
    '2.52.1'
  )
})

test('advisory index drift and cross-origin links are visible failures', () => {
  const config = { kind: 'webkit', url: 'https://webkitgtk.org/security.html' }
  assert.deepEqual(
    advisoryLinks(
      '<a href="security/WSA-2026-0006.html">advisory</a><a href="security/WSA-2024-0001.html">older</a>',
      config,
      2025
    ),
    ['https://webkitgtk.org/security/WSA-2026-0006.html']
  )
  assert.throws(
    () => advisoryLinks('no advisory links', config, 2025),
    /no longer/
  )
  assert.throws(
    () =>
      advisoryLinks(
        '<a href="https://attacker.invalid/WSA-2026-0006.html">advisory</a>',
        config,
        2025
      ),
    /cross-origin/
  )
})

test('exceptions bind an exact advisory and pin and expire visibly', () => {
  const finding = {
    component: 'webkitgtk',
    pinned: '2.52.5',
    id: 'CVE-2026-43804',
    kind: 'advisory',
  }
  const exception = {
    ...finding,
    expires: '2026-11-01',
    reason: 'Reviewed unreachable input path with specific evidence.',
  }
  assert.ok(
    applyExceptions([finding], [exception], new Date('2026-10-16')).findings[0]
      .exception
  )
  const changed = applyExceptions(
    [{ ...finding, pinned: '2.52.4' }],
    [exception],
    new Date('2026-10-16')
  )
  assert.equal(changed.findings[0].exception, undefined)
  assert.match(changed.errors.join(), /unused exception/)
  const expired = applyExceptions(
    [finding],
    [exception],
    new Date('2026-11-02')
  )
  assert.equal(expired.findings[0].exception, undefined)
  assert.match(expired.errors.join(), /expired exception/)
})

test('network failures are errors and cannot produce a clean report', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studyvis-native-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'scripts'))
  await writeFile(path.join(root, 'scripts/pin.env'), 'TEST_VERSION="2.52.5"\n')
  assert.equal(
    await pinnedVersion(root, { env: 'scripts/pin.env', key: 'TEST_VERSION' }),
    '2.52.5'
  )
  const report = await checkNative({
    root,
    policy: {
      schemaVersion: 1,
      components: [
        {
          id: 'webkitgtk',
          pin: { env: 'scripts/pin.env', key: 'TEST_VERSION' },
          feed: {
            kind: 'directory',
            url: 'https://webkitgtk.org/releases/',
            pattern: '(2\\.54\\.1)',
          },
        },
      ],
      exceptions: [],
    },
    fetchText: async () => {
      throw new Error('HTTP 503')
    },
  })
  assert.equal(report.findings.length, 0)
  assert.match(report.errors.join(), /HTTP 503/)
  assert.equal(report.components[0].pinned, '2.52.5')
})

test('freshness alone remains distinct from affected-version matches', async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'studyvis-native-freshness-')
  )
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'pin.env'), 'TEST_VERSION=1.28.7\n')
  const report = await checkNative({
    root,
    policy: {
      schemaVersion: 1,
      components: [
        {
          id: 'gstreamer',
          pin: { env: 'pin.env', key: 'TEST_VERSION' },
          feed: {
            kind: 'directory',
            url: 'https://gstreamer.freedesktop.org/src/gstreamer/',
            pattern: 'gstreamer-(\\d+\\.\\d+\\.\\d+)\\.tar',
          },
        },
      ],
      exceptions: [],
    },
    fetchText: async () => 'gstreamer-1.28.8.tar.xz',
  })
  assert.deepEqual(report.errors, [])
  assert.deepEqual(
    report.findings.map((finding) => finding.kind),
    ['freshness']
  )
})

test('full monitor preserves individual advisory findings and ignores patched ranges', async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'studyvis-native-integration-')
  )
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'pin.env'), 'TEST_VERSION=2.52.5\n')
  const source = 'https://webkitgtk.org/releases/'
  const index = 'https://webkitgtk.org/security.html'
  const advisory = 'https://webkitgtk.org/security/WSA-2026-0005.html'
  const pages = new Map([
    [source, 'webkitgtk-2.54.1.tar.xz'],
    [index, '<a href="security/WSA-2026-0005.html">advisory</a>'],
    [
      advisory,
      'CVE-2026-43804 Versions affected: WebKitGTK before 2.52.6. CVE-2026-28984 Versions affected: WebKitGTK before 2.52.4. We recommend updating.',
    ],
  ])
  const report = await checkNative({
    root,
    policy: {
      schemaVersion: 1,
      advisorySinceYear: 2025,
      components: [
        {
          id: 'webkitgtk',
          pin: { env: 'pin.env', key: 'TEST_VERSION' },
          feed: {
            kind: 'directory',
            url: source,
            pattern: 'webkitgtk-(\\d+\\.\\d+\\.\\d+)\\.tar',
          },
          advisories: { kind: 'webkit', url: index },
        },
      ],
      exceptions: [],
    },
    fetchText: async (url) => {
      assert.ok(pages.has(url))
      return pages.get(url)
    },
  })
  assert.deepEqual(report.errors, [])
  assert.deepEqual(
    report.findings.map((finding) => finding.id),
    ['newer-stable-release', 'CVE-2026-43804']
  )
  assert.equal(report.components[0].advisoryPages, 1)
})

test('native fetcher rejects unreviewed hosts before sending credentials or traffic', () => {
  let called = false
  const request = createFetcher(async () => {
    called = true
  })
  assert.throws(
    () => request('https://attacker.invalid/feed'),
    /unreviewed upstream/
  )
  assert.equal(called, false)
})
