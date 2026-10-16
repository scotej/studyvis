import { appendFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'webkitgtk.org',
  'gstreamer.freedesktop.org',
  'libnice.freedesktop.org',
  'musl.libc.org',
  'git.musl-libc.org',
])

export function compareVersions(left, right) {
  const parse = (value) => {
    if (!/^\d+(?:\.\d+)*$/.test(value))
      throw new Error(`unsupported numeric version: ${value}`)
    return value.split('.').map(Number)
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta) return Math.sign(delta)
  }
  return 0
}

export async function pinnedVersion(root, pin) {
  const contents = await readFile(path.join(root, pin.env ?? pin.tsv), 'utf8')
  if (pin.env) {
    const assignment = contents.match(
      new RegExp(
        `^${pin.key}=(?:"([^"\\n]+)"|'([^'\\n]+)'|([^\\s#]+))\\s*$`,
        'm'
      )
    )
    if (!assignment) throw new Error(`missing literal pin ${pin.key}`)
    return assignment[1] ?? assignment[2] ?? assignment[3]
  }
  const lines = contents.trim().split('\n')
  const columns = lines.shift().split('\t')
  const rows = lines.map((line) =>
    Object.fromEntries(
      line.split('\t').map((value, index) => [columns[index], value])
    )
  )
  const matches = rows.filter((row) => row.component === pin.component)
  if (matches.length !== 1)
    throw new Error(`expected one source tuple for ${pin.component}`)
  return matches[0].version
}

export function releaseVersion(body, feed) {
  const pattern = new RegExp(feed.pattern, 'g')
  let candidates
  if (feed.kind === 'directory') {
    candidates = [...body.matchAll(pattern)].map((match) => match[1])
  } else {
    const entries = JSON.parse(body)
    if (!Array.isArray(entries))
      throw new Error('upstream release feed is not an array')
    candidates = entries
      .filter(
        (entry) => !entry.draft && (!entry.prerelease || feed.includePrerelease)
      )
      .map((entry) =>
        feed.kind === 'github-tags' ? entry.name : entry.tag_name
      )
      .flatMap((name) =>
        [...String(name).matchAll(new RegExp(feed.pattern, 'g'))].map(
          (match) => match[1]
        )
      )
  }
  candidates = candidates.filter(
    (version) => !feed.evenMinor || Number(version.split('.')[1]) % 2 === 0
  )
  if (candidates.length === 0)
    throw new Error('no supported stable versions in upstream feed')
  return candidates.sort(compareVersions).at(-1)
}

function plainText(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function advisoryLinks(html, config, sinceYear) {
  const expression =
    config.kind === 'webkit'
      ? /href=["']([^"']*WSA-(\d{4})-\d+\.html)["']/gi
      : /href=["']([^"']*sa-(\d{4})-\d+\.html)["']/gi
  const all = [...html.matchAll(expression)]
  if (!all.length)
    throw new Error(
      'upstream advisory index no longer has recognized advisory links'
    )
  return [
    ...new Set(
      all
        .filter((match) => Number(match[2]) >= sinceYear)
        .map((match) => {
          const url = new URL(match[1], config.url)
          if (url.origin !== new URL(config.url).origin)
            throw new Error('cross-origin advisory link')
          return url.href
        })
    ),
  ]
}

export function parseWebkitAdvisory(html, pinned, url) {
  const text = plainText(html)
  const records = [
    ...text.matchAll(
      /(CVE-\d{4}-\d+)\s+Versions affected:\s*(.*?)(?=CVE-\d{4}-\d+\s+Versions affected:|We recommend|$)/g
    ),
  ]
  if (!records.length)
    throw new Error(`unrecognized WebKit affected-version data: ${url}`)
  return records.flatMap((record) => {
    const affected = record[2].split(/\.\s/)[0]
    if (!/\bbefore\s+\d/.test(affected))
      throw new Error(`unrecognized affected range for ${record[1]}`)
    const fixedVersion = branchFix(
      pinned,
      [...affected.matchAll(/\b(\d+\.\d+\.\d+)\b/g)].map((match) => match[1])
    )
    if (compareVersions(pinned, fixedVersion) >= 0) return []
    return [{ id: record[1], kind: 'advisory', fixedVersion, url }]
  })
}

function branchFix(pinned, fixedVersions) {
  if (!fixedVersions.length)
    throw new Error('no fixed versions in upstream affected range')
  const branch = pinned.split('.').slice(0, 2).join('.')
  const matching = fixedVersions.filter(
    (version) => version.split('.').slice(0, 2).join('.') === branch
  )
  return (matching.length ? matching : fixedVersions)
    .sort(compareVersions)
    .at(-1)
}

export function parseGstreamerAdvisory(
  html,
  pinned,
  url,
  bundledModules = new Set([
    'gstreamer',
    'gst-plugins-base',
    'gst-plugins-good',
    'gst-plugins-bad',
  ])
) {
  const text = plainText(html)
  const id = text.match(/\bGStreamer-SA-\d{4}-\d+\b/)?.[0]
  const affected = text.match(
    /Affected Versions\s+(.*?)(?:\s+IDs\s|\s+Details\s)/
  )?.[1]
  if (!id || !affected)
    throw new Error(`unrecognized GStreamer advisory: ${url}`)
  const module =
    affected
      .match(
        /\bgst-(?:plugins-(?:base|good|bad|ugly)|libav|rtsp-server|editing-services)\b/i
      )?.[0]
      .toLowerCase() ??
    (/\bEditing Services\b|\bGES\b/i.test(affected)
      ? 'gst-editing-services'
      : /\bOrc\b/i.test(affected)
        ? 'orc'
        : /^(?:GStreamer\s+)?(?:core\s+)?[<>\d]/i.test(affected)
          ? 'gstreamer'
          : undefined)
  if (!module)
    throw new Error(
      `unrecognized GStreamer source module for ${id}: ${affected}`
    )
  if (!bundledModules.has(module))
    return [
      {
        id,
        kind: 'excluded',
        module,
        affected,
        url,
        reason: `${module} is absent from the pinned source-built runtime; only ${[...bundledModules].join(', ')} are built`,
      },
    ]
  const range = affected.slice(affected.search(/[<>\d]/))
  const alternatives = range.split(/\s+(?:or|\|\|)\s+|;/i)
  const lowerBound = range.match(/>=\s*(\d+\.\d+\.\d+)/)
  if (lowerBound && alternatives.length > 1) {
    const matches = alternatives
      .map((alternative) => {
        const bound = alternative.match(
          /^\s*>=\s*(\d+\.\d+\.\d+)\s*,?\s*<\s*(\d+\.\d+\.\d+)\s*$/
        )
        if (!bound)
          throw new Error(`unrecognized affected range for ${id}: ${affected}`)
        return { lower: bound[1], fixed: bound[2] }
      })
      .filter(
        (bound) =>
          compareVersions(pinned, bound.lower) >= 0 &&
          compareVersions(pinned, bound.fixed) < 0
      )
    return matches.map((bound) => ({
      id,
      kind: 'advisory',
      fixedVersion: bound.fixed,
      affected,
      module,
      url,
    }))
  }
  const thresholds = [...range.matchAll(/<\s*(\d+\.\d+\.\d+)/g)].map(
    (match) => match[1]
  )
  if (!thresholds.length || /[\d.]\s*(?:through|to|-)\s*[\d.]/i.test(range))
    throw new Error(`unrecognized affected range for ${id}: ${affected}`)
  const fixedVersion = branchFix(pinned, thresholds)
  if (
    (lowerBound && compareVersions(pinned, lowerBound[1]) < 0) ||
    compareVersions(pinned, fixedVersion) >= 0
  )
    return []
  return [{ id, kind: 'advisory', fixedVersion, affected, module, url }]
}

export function applyExceptions(findings, exceptions, now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  const validExpiry = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false
    const date = new Date(`${value}T00:00:00Z`)
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    )
  }
  const used = new Set()
  const errors = []
  for (const [index, exception] of exceptions.entries()) {
    if (
      !exception.component ||
      !exception.pinned ||
      !exception.id ||
      !validExpiry(exception.expires) ||
      (exception.reason ?? '').trim().length < 16
    )
      errors.push(
        `exception ${index} needs exact component/pin/advisory, expiry and a reviewed reason`
      )
    else if (exception.expires < day)
      errors.push(`expired exception: ${exception.component}/${exception.id}`)
  }
  const reviewed = findings.map((finding) => {
    const index = exceptions.findIndex(
      (exception) =>
        exception.component === finding.component &&
        exception.pinned === finding.pinned &&
        exception.id === finding.id &&
        validExpiry(exception.expires) &&
        exception.expires >= day &&
        (exception.reason ?? '').trim().length >= 16
    )
    if (index < 0) return finding
    used.add(index)
    return { ...finding, exception: exceptions[index] }
  })
  for (const [index, exception] of exceptions.entries()) {
    if (!used.has(index))
      errors.push(
        `unused exception: ${exception.component}/${exception.id}; review or remove it`
      )
  }
  return { findings: reviewed, errors }
}

export function createFetcher(fetchImpl = fetch) {
  const cache = new Map()
  return function fetchText(input) {
    const url = new URL(input)
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname))
      throw new Error(`unreviewed upstream URL: ${input}`)
    if (cache.has(input)) return cache.get(input)
    const request = (async () => {
      let failure
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const headers = {
            'User-Agent': 'StudyVis-native-advisory-monitor',
            Accept: 'application/json, text/html',
          }
          if (url.hostname === 'api.github.com' && process.env.GH_TOKEN)
            headers.Authorization = `Bearer ${process.env.GH_TOKEN}`
          const response = await fetchImpl(url, {
            headers,
            signal: AbortSignal.timeout(20_000),
            redirect: 'error',
          })
          if (!response.ok)
            throw new Error(`HTTP ${response.status} from ${input}`)
          const body = await response.text()
          if (Buffer.byteLength(body) > 4 * 1024 * 1024)
            throw new Error(`upstream response exceeds 4 MiB: ${input}`)
          return body
        } catch (error) {
          failure = error
          if (attempt < 2)
            await new Promise((resolve) =>
              setTimeout(resolve, 500 * (attempt + 1))
            )
        }
      }
      throw failure
    })()
    cache.set(input, request)
    return request
  }
}

async function mapConcurrent(items, limit, callback) {
  let index = 0
  const results = new Array(items.length)
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index++
        results[current] = await callback(items[current])
      }
    })
  )
  return results
}

export async function checkNative({
  root = ROOT,
  policy,
  fetchText = createFetcher(),
  now = new Date(),
} = {}) {
  policy ??= JSON.parse(
    await readFile(
      path.join(root, 'scripts/native-component-policy.json'),
      'utf8'
    )
  )
  if (
    policy.schemaVersion !== 1 ||
    !Array.isArray(policy.components) ||
    !Array.isArray(policy.exceptions)
  )
    throw new Error('unsupported native component policy')
  const errors = []
  const findings = []
  const excludedAdvisories = []
  const components = await mapConcurrent(
    policy.components,
    3,
    async (component) => {
      let pinned
      try {
        pinned = await pinnedVersion(root, component.pin)
        const feed = component.feed
        const source =
          feed.url ??
          `https://api.github.com/repos/${feed.repo}/${feed.kind === 'github-tags' ? 'tags' : feed.kind === 'github-commits' ? 'commits' : 'releases'}?per_page=${feed.kind === 'github-tags' ? 100 : feed.kind === 'github-commits' ? 1 : 30}`
        const body = await fetchText(source)
        let latest
        if (feed.kind === 'github-commits') {
          latest = JSON.parse(body)[0]?.sha
          if (!/^[0-9a-f]{40}$/.test(latest ?? ''))
            throw new Error('upstream commit feed has no source revision')
          if (latest !== pinned) {
            const comparison = JSON.parse(
              await fetchText(
                `https://api.github.com/repos/${feed.repo}/compare/${pinned}...${latest}`
              )
            )
            if (!['ahead', 'identical'].includes(comparison.status))
              throw new Error(
                'pinned source is not an ancestor of upstream; manual source review needed'
              )
            findings.push({
              component: component.id,
              pinned,
              id: 'upstream-source-changed',
              kind: 'freshness',
              latest,
              url: `https://github.com/${feed.repo}/compare/${pinned}...${latest}`,
            })
          }
        } else {
          latest = releaseVersion(body, feed)
          const numericPin =
            component.id === 'llama.cpp' ? pinned.replace(/^b/, '') : pinned
          const newer = compareVersions(numericPin, latest) < 0
          if (component.id === 'llama.cpp') latest = `b${latest}`
          if (newer)
            findings.push({
              component: component.id,
              pinned,
              id: feed.includePrerelease
                ? 'newer-upstream-build'
                : 'newer-stable-release',
              kind: 'freshness',
              latest,
              url: source,
            })
        }
        let advisoryCount = 0
        let excludedCount = 0
        if (component.advisories) {
          let bundledModules
          if (component.advisories.kind === 'gstreamer') {
            const tuple = await readFile(
              path.join(root, 'scripts/linux-webkit-runtime.env'),
              'utf8'
            )
            const modules = {
              CORE: 'gstreamer',
              BASE: 'gst-plugins-base',
              GOOD: 'gst-plugins-good',
              BAD: 'gst-plugins-bad',
            }
            bundledModules = new Set(
              Object.entries(modules)
                .filter(([key]) =>
                  new RegExp(
                    `^STUDYVIS_GSTREAMER_${key}_SOURCE_URL=`,
                    'm'
                  ).test(tuple)
                )
                .map(([, module]) => module)
            )
            if (bundledModules.size !== 4)
              throw new Error(
                'pinned GStreamer source-built module inventory changed; review advisory coverage'
              )
          }
          const links = advisoryLinks(
            await fetchText(component.advisories.url),
            component.advisories,
            policy.advisorySinceYear
          )
          if (!links.length || links.length > 300)
            throw new Error(
              'upstream advisory window is empty or exceeds the reviewed 300-page bound'
            )
          const results = await mapConcurrent(links, 4, async (url) => {
            try {
              const html = await fetchText(url)
              return (
                component.advisories.kind === 'webkit'
                  ? parseWebkitAdvisory
                  : parseGstreamerAdvisory
              )(html, pinned, url, bundledModules)
            } catch (error) {
              errors.push(
                `${component.id}: advisory coverage incomplete: ${error.message}`
              )
              return []
            }
          })
          advisoryCount = links.length
          const records = results
            .flat()
            .map((finding) => ({ ...finding, component: component.id, pinned }))
          const excluded = records.filter(
            (finding) => finding.kind === 'excluded'
          )
          excludedCount = excluded.length
          excludedAdvisories.push(...excluded)
          findings.push(
            ...records.filter((finding) => finding.kind !== 'excluded')
          )
        }
        return {
          id: component.id,
          pinned,
          latest,
          source,
          advisoryPages: advisoryCount,
          excludedUnbundledAdvisories: excludedCount,
        }
      } catch (error) {
        errors.push(`${component.id}: ${error.message}`)
        return { id: component.id, pinned, error: error.message }
      }
    }
  )
  const reviewed = applyExceptions(findings, policy.exceptions, now)
  errors.push(...reviewed.errors)
  return {
    checkedAt: now.toISOString(),
    coverage: policy.coverage,
    components,
    findings: reviewed.findings,
    excludedAdvisories,
    errors,
  }
}

export function markdown(report) {
  const clean = (value) => String(value ?? '').replace(/[|<>\r\n]/g, ' ')
  const lines = [
    '### Bundled native component monitoring',
    '',
    report.coverage,
    '',
    '| Component | Pinned | Upstream | Advisory pages | Unbundled exclusions |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const component of report.components)
    lines.push(
      `| ${clean(component.id)} | ${clean(component.pinned)} | ${clean(component.error ?? component.latest)} | ${component.advisoryPages ?? 'failed'} | ${component.excludedUnbundledAdvisories ?? 0} |`
    )
  lines.push(
    '',
    'Newer releases/source revisions are freshness signals, not vulnerability determinations. Version-range advisory matches require review of bundled plugins, patches and reachable input paths.',
    ''
  )
  const excludedModules = new Map()
  for (const finding of report.excludedAdvisories ?? [])
    excludedModules.set(
      finding.module,
      (excludedModules.get(finding.module) ?? 0) + 1
    )
  if (excludedModules.size)
    lines.push(
      `Unbundled GStreamer modules excluded: ${[...excludedModules].map(([module, count]) => `${clean(module)} (${count} advisories)`).join(', ')}. Only the source-pinned core/base/good/bad modules are built; individual plugin reachability within them requires review.`,
      ''
    )
  const groups = new Map()
  for (const finding of report.findings) {
    if (finding.kind !== 'advisory' || finding.exception) continue
    const key = `${finding.component}/${finding.url}/${finding.fixedVersion}`
    const group = groups.get(key) ?? []
    group.push(finding)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const first = group[0]
    lines.push(
      `- **Affected-version matches:** ${clean(first.component)} ${clean(first.pinned)} — ${group.length} advisory ID(s), fixed in ${clean(first.fixedVersion)}. [Upstream](${first.url}). ${group
        .slice(0, 8)
        .map((finding) => clean(finding.id))
        .join(
          ', '
        )}${group.length > 8 ? '; remaining IDs are in the JSON report' : ''}.`
    )
  }
  for (const finding of report.findings.filter(
    (item) => item.kind !== 'advisory' || item.exception
  ))
    lines.push(
      `- ${finding.exception ? 'Reviewed exception' : finding.kind === 'advisory' ? 'Affected-version match' : 'Freshness'}: ${clean(finding.component)} ${clean(finding.pinned)} — ${clean(finding.id)}${finding.fixedVersion ? ` (fixed in ${clean(finding.fixedVersion)})` : ` (upstream ${clean(finding.latest)})`}. [Upstream](${finding.url})${finding.exception ? ` — ${clean(finding.exception.reason)}; expires ${finding.exception.expires}` : ''}`
    )
  for (const error of report.errors)
    lines.push(`- **Coverage error:** ${clean(error)}`)
  return `${lines.join('\n')}\n`
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--output'))
      throw new Error(
        'usage: node scripts/check-native-advisories.mjs [--output report.json]'
      )
    const report = await checkNative()
    const summary = markdown(report)
    process.stdout.write(summary)
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
    if (args[1])
      await writeFile(args[1], `${JSON.stringify(report, null, 2)}\n`)
    if (
      report.errors.length ||
      report.findings.some(
        (finding) => finding.kind === 'advisory' && !finding.exception
      )
    )
      process.exitCode = 1
  } catch (error) {
    console.error(`Native monitoring failed: ${error.message}`)
    process.exitCode = 1
  }
}
