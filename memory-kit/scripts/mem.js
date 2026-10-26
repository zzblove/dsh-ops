#!/usr/bin/env node
/**
 * memory-kit · a DSH-oriented rewrite of markdown-project-memory
 * ============================================================================
 * Origin: https://github.com/zzblove/markdown-project-memory (MIT).
 *
 * Why a rewrite: a DSH plugin or headless round may have no Python available
 * (common on Windows), but it always has Node. This keeps the *protocol*
 * identical — same `memory/` layout, same frontmatter, same `index.md` format —
 * so a project can use either implementation interchangeably.
 *
 * Deliberately dropped (kept out of DSH's daily path, avoids network and keys):
 *   - embeddings / rerank / any cloud API (retrieval is local keywords only)
 *   - the HTTP service, eval harness, handoff bundles and annotate
 *
 * Kept: init / add / search / show / reindex / doctor / stats / outdated
 *
 * Usage (from the project root):
 *   node memory-kit/scripts/mem.js init
 *   node memory-kit/scripts/mem.js add --type fact --title "..." --summary "..." --body-file body.md
 *   node memory-kit/scripts/mem.js search "query" -k 3
 *   node memory-kit/scripts/mem.js show memory/facts/x.md --grep "term" -C 2
 *   node memory-kit/scripts/mem.js reindex | doctor | stats | outdated
 *
 * The memory directory defaults to the parent of this script; override it with
 * MEMORY_DIR or `--dir`.
 * ============================================================================
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const VERSION = '1.1.0'

/** Canonical type list of the default (engineering) profile, kept for compatibility. */
export const TYPES = ['fact', 'decision', 'howto', 'correction']

/**
 * Directory taxonomies. A memory project picks one at `init` time and records it
 * in `memory/.profile.json`; every later command reads that file, so the same CLI
 * serves different kinds of projects without renaming anything.
 *
 * `dir: '@target'` means "same directory as the entry being corrected".
 */
export const PROFILES = {
  engineering: {
    name: 'engineering',
    title: 'Engineering memory',
    types: {
      fact: { dir: 'facts', hint: 'environment truth / verified current state' },
      decision: { dir: 'decisions', hint: 'a choice with rationale and rejected options' },
      howto: { dir: 'howto', hint: 'steps that actually worked' },
      correction: { dir: '@target', hint: 'correct an existing entry via supersedes' },
    },
  },
  bili: {
    name: 'bili',
    title: 'Watch-and-talk memory',
    types: {
      taste: { dir: 'taste', hint: 'what the user likes or avoids, tone and length preferences' },
      video: { dir: 'videos', hint: 'takeaways from specific videos worth recalling later' },
      talk: { dir: 'talks', hint: 'conclusions, decisions and promises made in conversation' },
      creator: { dir: 'creators', hint: 'uploaders or people worth following or avoiding' },
      correction: { dir: '@target', hint: 'correct an existing entry via supersedes' },
    },
  },
}

export const PROFILE_NAMES = Object.keys(PROFILES)

/** Look a profile up by name (unknown names fall back to engineering). */
export function profileByName(name) {
  return PROFILES[String(name || '').trim()] || PROFILES.engineering
}

/** The profile a memory project was initialised with; defaults to engineering. */
export function profileOf(memDir) {
  try {
    const j = JSON.parse(readFileSync(join(memDir, 'memory', '.profile.json'), 'utf8'))
    if (j && PROFILES[j.profile]) return PROFILES[j.profile]
  } catch { /* not initialised by this edition */ }
  return PROFILES.engineering
}

/** Types valid for a project, in declaration order. */
export function typesOf(memDir) {
  return Object.keys(profileOf(memDir).types)
}

const INDEX_HEAD = '# Memory index\n\nAppend only; use mem.js add so the index and the write lock stay consistent.\n'

export function memoryDirOf(env = process.env) {
  if (env.MEMORY_DIR) return resolve(env.MEMORY_DIR)
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** index.md lives at memory/index.md in both implementations */
export const indexPath = (memDir) => join(memDir, 'memory', 'index.md')

/* ─────────────────────────── markdown parsing ─────────────────────────── */

/** Split frontmatter. Values are JSON-decoded when they look like JSON. */
export function parseDoc(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const meta = {}
  let body = src
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---', 4)
    if (end >= 0) {
      for (const line of src.slice(4, end).split('\n')) {
        const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
        if (!m) continue
        meta[m[1]] = coerce(m[2].trim())
      }
      body = src.slice(end + 4).replace(/^\n/, '')
    }
  }
  const t = /^#\s+(.+)$/m.exec(body)
  return { meta, body, title: t ? t[1].trim() : '' }
}

function coerce(raw) {
  if (raw.startsWith('"') || raw.startsWith('[') || raw.startsWith('{')) {
    try { return JSON.parse(raw) } catch { return raw }
  }
  return raw
}

/** Load every entry under memory/ (index.md and dotfiles excluded). */
export function loadDocs(memDir) {
  const docs = new Map()
  const walk = (dir) => {
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.md') || e.name === 'index.md') continue
      let text = ''
      try { text = readFileSync(p, 'utf8') } catch { continue }
      const parsed = parseDoc(text)
      const rel = relative(memDir, p).split(sep).join('/')
      docs.set(rel, { rel, path: p, text, meta: parsed.meta, body: parsed.body, title: parsed.title })
    }
  }
  walk(join(memDir, 'memory'))
  return docs
}

/** An entry is effective unless its status is `outdated`. */
export const isActive = (doc) => String(doc.meta.status || 'active') !== 'outdated'

/* ─────────────────────────── local retrieval ─────────────────────────── */

/**
 * Tokenize: ASCII words plus CJK bigrams. Single characters are only used when
 * the query has no bigram at all — otherwise common characters match everything.
 */
export function tokenize(q) {
  const s = String(q || '').toLowerCase()
  const out = new Set()
  for (const w of s.match(/[a-z0-9_.@/-]{2,}/g) || []) out.add(w)
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, ' ')
  const bigrams = []
  const singles = []
  for (const seg of cjk.split(/\s+/)) {
    for (let i = 0; i < seg.length; i++) {
      singles.push(seg[i])
      if (i + 1 < seg.length) bigrams.push(seg.slice(i, i + 2))
    }
  }
  for (const b of bigrams) out.add(b)
  if (!bigrams.length) for (const c of singles) out.add(c)
  return [...out]
}

const countOf = (hay, needle) => {
  if (!needle) return 0
  let n = 0
  let i = 0
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length }
  return n
}

/** Title and summary weigh more than body occurrences (which are capped). */
export function scoreDoc(doc, terms) {
  const title = String(doc.title || '').toLowerCase()
  const summary = String(doc.meta.summary || '').toLowerCase()
  const scope = String(doc.meta.scope || '').toLowerCase()
  const body = String(doc.body || '').toLowerCase()
  let score = 0
  for (const t of terms) {
    if (title.includes(t)) score += 6
    if (summary.includes(t)) score += 4
    if (scope.includes(t)) score += 2
    score += Math.min(8, countOf(body, t))
  }
  return score
}

/** Line range around the first hit, for `show --lines`. */
export function hitLines(doc, terms) {
  const lines = String(doc.text || '').split('\n')
  const low = lines.map((l) => l.toLowerCase())
  const idx = []
  for (let i = 0; i < low.length; i++) if (terms.some((t) => low[i].includes(t))) idx.push(i)
  if (!idx.length) return '1-' + Math.min(lines.length, 40)
  const a = Math.max(1, idx[0] - 3)
  const b = Math.min(lines.length, idx[idx.length - 1] + 4)
  return a + '-' + b
}

function snippetOf(doc, terms, max = 120) {
  const body = String(doc.body || '').replace(/\s+/g, ' ').trim()
  const low = body.toLowerCase()
  let at = -1
  for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i }
  if (at < 0) return body.slice(0, max)
  const from = Math.max(0, at - 30)
  return (from > 0 ? '...' : '') + body.slice(from, from + max)
}

/**
 * Local keyword search; never touches the network.
 * @returns {Array<{doc:object, score:number, lines:string, snippet:string}>}
 */
export function search(memDir, query, { k = 3, includeOutdated = false } = {}) {
  const terms = tokenize(query)
  if (!terms.length) return []
  const hits = []
  for (const d of loadDocs(memDir).values()) {
    if (!includeOutdated && !isActive(d)) continue
    const score = scoreDoc(d, terms)
    if (score <= 0) continue
    hits.push({ doc: d, score, lines: hitLines(d, terms), snippet: snippetOf(d, terms) })
  }
  hits.sort((a, b) => b.score - a.score || String(b.doc.meta.date || '').localeCompare(String(a.doc.meta.date || '')))
  return hits.slice(0, Math.max(1, Math.min(Number(k) || 3, 20)))
}

/** Render candidates in the same shape as the Python implementation. */
export function renderSearch(query, hits) {
  const head = `query: ${query}  (local retrieval, no API call, ${hits.length} candidate(s))`
  if (!hits.length) return head + '\nno relevant memory'
  const blocks = hits.map((h, i) => {
    const d = h.doc
    const bits = [`[${i + 1}] ${d.meta.date || ''} [${d.meta.status || 'active'}] score=${h.score.toFixed(3)}  ${d.rel}  lines ${h.lines}`]
    if (d.meta.scope) bits.push(`    scope: ${d.meta.scope}`)
    if (d.meta.verified_at) bits.push(`    verified: ${d.meta.verified_at}`)
    if (d.meta.source) bits.push(`    source: ${d.meta.source}`)
    if (d.meta.summary) bits.push(`    summary: ${d.meta.summary}`)
    bits.push(`    excerpt: ${h.snippet}`)
    bits.push(`    read: node memory-kit/scripts/mem.js show '${d.rel}' --lines ${h.lines}`)
    return bits.join('\n')
  })
  return [head, ...blocks, 'note: summaries/excerpts are for triage only; read the original before quoting numbers or paths.'].join('\n')
}

/* ─────────────────────────── write lock / writes ─────────────────────────── */

/** Cross-process write lock: created with wx, taken over when the holder is dead. */
export function withLock(memDir, fn) {
  mkdirSync(memDir, { recursive: true })
  const lock = join(memDir, '.write.lock')
  const mine = `${process.pid}@${new Date().toISOString()}`
  const deadline = Date.now() + 5000
  let held = false
  while (Date.now() < deadline) {
    try {
      writeFileSync(lock, mine, { flag: 'wx' })
      held = true
      break
    } catch {
      let owner = ''
      try { owner = readFileSync(lock, 'utf8') } catch { /* released meanwhile */ }
      const pid = Number(String(owner).split('@')[0]) || 0
      let alive = false
      if (pid > 0) { try { process.kill(pid, 0); alive = true } catch { alive = false } }
      const age = Date.now() - (() => { try { return statSync(lock).mtimeMs } catch { return 0 } })()
      if (!alive || age > 30_000) { try { rmSync(lock, { force: true }) } catch { /* retry */ } continue }
      const until = Date.now() + 50
      while (Date.now() < until) { /* brief spin; no timers in sync path */ }
    }
  }
  try {
    return fn()
  } finally {
    if (held) { try { rmSync(lock, { force: true }) } catch { /* taken over later */ } }
  }
}

const nowStamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    at: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    name: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`,
  }
}

const slugOf = (title) => String(title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[ .]+|[ .]+$/g, '').slice(0, 70) || 'memory'

function identityOf({ type, title, summary, body, scope, source, verifiedAt, supersedes }) {
  return createHash('sha256')
    .update(JSON.stringify([type, title, summary, String(body || '').trim(), scope, source, verifiedAt, supersedes || '']))
    .digest('hex')
}

/** Append one line to memory/index.md unless the file is already listed. */
function indexAppend(memDir, rel, title, summary) {
  const f = indexPath(memDir)
  mkdirSync(dirname(f), { recursive: true })
  if (!existsSync(f)) writeFileSync(f, INDEX_HEAD, 'utf8')
  const text = readFileSync(f, 'utf8')
  if (text.includes('`' + rel + '`')) return false
  appendFileSync(f, `- ${title} — \`${rel}\` — ${summary}\n\n`, 'utf8')
  return true
}

/**
 * Append one memory entry (write-locked; byte-identical duplicates are reused).
 * @returns {{ reused:boolean, rel:string, path:string }}
 */
export function addEntry(memDir, { type, title, summary, body, scope = '', source = '', verifiedAt = '', supersedes = '', noDedupe = false }) {
  const profile = profileOf(memDir)
  const t = String(type || '').trim()
  const spec = profile.types[t]
  if (!spec) throw new Error(`type must be one of ${Object.keys(profile.types).join(' / ')} (profile: ${profile.name})`)
  const cleanTitle = String(title || '').trim()
  const cleanSummary = String(summary || '').trim()
  if (!cleanTitle || !cleanSummary || cleanSummary.includes('\n')) throw new Error('title and summary must be non-empty single lines')
  if (t === 'correction' && !supersedes) throw new Error('correction requires supersedes (path of the corrected entry)')
  if (supersedes && t !== 'correction') throw new Error('supersedes is only valid for correction')
  const cleanBody = String(body || '').replace(/\r\n/g, '\n').trim()
  if (!cleanBody) throw new Error('body must not be empty')
  const finalTitle = t === 'correction' && !cleanTitle.startsWith('Correction:') ? 'Correction: ' + cleanTitle : cleanTitle
  const identity = identityOf({ type: t, title: finalTitle, summary: cleanSummary, body: cleanBody, scope, source, verifiedAt, supersedes })

  return withLock(memDir, () => {
    const docs = loadDocs(memDir)
    if (!noDedupe) {
      for (const d of docs.values()) {
        if (!isActive(d)) continue
        const previous = identityOf({
          type: d.meta.type || '',
          title: d.title,
          summary: d.meta.summary || '',
          body: String(d.body).replace(/^#\s+[^\n]*(?:\n|$)/, ''),
          scope: d.meta.scope || '',
          source: d.meta.source || '',
          verifiedAt: d.meta.verified_at || '',
          supersedes: Array.isArray(d.meta.supersedes) ? d.meta.supersedes[0] : (d.meta.supersedes || ''),
        })
        if (previous === identity) return { reused: true, rel: d.rel, path: d.path }
      }
    }
    const targetRel = supersedes ? String(supersedes).replace(/\\/g, '/').replace(/^\.\//, '') : ''
    if (targetRel && !docs.has(targetRel)) throw new Error('entry to correct does not exist: ' + targetRel)
    // `@target` keeps a correction next to the entry it corrects
    const fallbackDir = Object.values(profile.types).map((x) => x.dir).find((d) => d !== '@target') || 'facts'
    const dir = spec.dir === '@target' ? (targetRel.split('/')[1] || fallbackDir) : spec.dir
    const st = nowStamp()
    const rel = `memory/${dir}/${st.name}-${slugOf(finalTitle)}-${randomUUID().slice(0, 8)}.md`
    const path = join(memDir, rel.split('/').join(sep))
    const meta = [
      '---',
      `date: ${st.date}`,
      `created_at: ${st.at}`,
      'status: active',
      `type: ${t}`,
      `summary: ${JSON.stringify(cleanSummary)}`,
      ...(scope ? [`scope: ${JSON.stringify(scope)}`] : []),
      ...(source ? [`source: ${JSON.stringify(source)}`] : []),
      ...(verifiedAt ? [`verified_at: ${JSON.stringify(verifiedAt)}`] : []),
      ...(targetRel ? [`supersedes: ${JSON.stringify(targetRel)}`] : []),
      '---',
      '',
    ].join('\n')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, meta + `# ${finalTitle}\n\n${cleanBody}\n`, 'utf8')
    if (targetRel) markOutdated(memDir, targetRel, st.date)
    indexAppend(memDir, rel, finalTitle, cleanSummary)
    return { reused: false, rel, path }
  })
}

/** Mark an entry outdated: status flips, body and date stay untouched. */
export function markOutdated(memDir, rel, when) {
  const path = join(memDir, String(rel).split('/').join(sep))
  if (!existsSync(path)) return false
  let text = readFileSync(path, 'utf8')
  if (!/^status:\s*active$/m.test(text)) return false
  text = text.replace(/^status:\s*active$/m, 'status: outdated')
  if (/^updated:\s*/m.test(text)) text = text.replace(/^updated:\s*.*$/m, 'updated: ' + when)
  else text = text.replace(/^---\n/, `---\nupdated: ${when}\n`)
  writeFileSync(path, text, 'utf8')
  return true
}

/* ─────────────────────────── index / health ─────────────────────────── */

export function reindex(memDir) {
  const docs = loadDocs(memDir)
  let added = 0
  for (const d of docs.values()) {
    if (!isActive(d)) continue
    if (indexAppend(memDir, d.rel, d.title || d.rel, String(d.meta.summary || ''))) added++
  }
  const cache = {
    version: VERSION,
    at: new Date().toISOString(),
    dir: memDir,
    files: [...docs.values()].map((d) => ({
      rel: d.rel,
      type: d.meta.type || '',
      status: d.meta.status || 'active',
      date: d.meta.date || '',
      summary: d.meta.summary || '',
      size: String(d.text).length,
      sha: createHash('sha256').update(String(d.text)).digest('hex').slice(0, 16),
    })),
  }
  writeFileSync(join(memDir, '.index.json'), JSON.stringify(cache, null, 2), 'utf8')
  return { total: docs.size, indexAdded: added }
}

export function doctor(memDir) {
  const docs = loadDocs(memDir)
  const issues = []
  const titles = new Map()
  for (const d of docs.values()) {
    if (!d.title) issues.push(`${d.rel}: missing a level-1 heading`)
    if (!d.meta.date) issues.push(`${d.rel}: frontmatter has no date`)
    if (!d.meta.summary) issues.push(`${d.rel}: frontmatter has no summary`)
    if (!d.meta.type) issues.push(`${d.rel}: frontmatter has no type`)
    const key = String(d.title).trim()
    if (key) {
      if (titles.has(key)) issues.push(`${d.rel}: duplicate title of ${titles.get(key)}`)
      else titles.set(key, d.rel)
    }
    const sup = d.meta.supersedes
    const list = Array.isArray(sup) ? sup : (sup ? [sup] : [])
    for (const s of list) if (!docs.has(String(s))) issues.push(`${d.rel}: supersedes points at missing ${s}`)
  }
  const idx = indexPath(memDir)
  if (existsSync(idx)) {
    for (const m of readFileSync(idx, 'utf8').matchAll(/`([^`]+\.md)`/g)) {
      const rel = m[1].replace(/\\/g, '/')
      if (!docs.has(rel)) issues.push(`memory/index.md: points at missing ${rel}`)
    }
  } else {
    issues.push('memory/index.md is missing (run reindex)')
  }
  return { files: docs.size, issues }
}

export function stats(memDir) {
  const profile = profileOf(memDir)
  const docs = [...loadDocs(memDir).values()]
  const byType = {}
  const byStatus = {}
  for (const d of docs) {
    const t = d.meta.type || '(none)'
    byType[t] = (byType[t] || 0) + 1
    const s = d.meta.status || 'active'
    byStatus[s] = (byStatus[s] || 0) + 1
  }
  let indexEntries = 0
  try {
    indexEntries = readFileSync(indexPath(memDir), 'utf8').split('\n').filter((l) => l.trim().startsWith('- ')).length
  } catch { /* no index yet */ }
  return { version: VERSION, profile: profile.name, files: docs.length, byType, byStatus, indexEntries }
}

export function outdated(memDir, months = 6) {
  const cutoff = new Date(Date.now() - months * 30 * 86400_000).toISOString().slice(0, 10)
  const rows = []
  for (const d of loadDocs(memDir).values()) {
    if (!isActive(d)) continue
    const day = String(d.meta.updated || d.meta.date || '').slice(0, 10)
    if (day && day < cutoff) rows.push({ rel: d.rel, day, type: d.meta.type || '' })
  }
  return rows
}

/** Idempotently scaffold a memory project with the given directory profile. */
export function initProject(target, { profile = 'engineering' } = {}) {
  const p = profileByName(profile)
  const root = resolve(target)
  mkdirSync(join(root, 'memory'), { recursive: true })
  for (const spec of Object.values(p.types)) {
    if (spec.dir === '@target') continue
    mkdirSync(join(root, 'memory', spec.dir), { recursive: true })
  }
  const idx = indexPath(root)
  if (!existsSync(idx)) writeFileSync(idx, INDEX_HEAD, 'utf8')
  // ship the CLI into the project so it is self-contained (the Python edition copies mem.py the same way)
  const self = fileURLToPath(import.meta.url)
  const dest = join(root, 'scripts', 'mem.js')
  try {
    mkdirSync(dirname(dest), { recursive: true })
    if (resolve(self) !== resolve(dest)) copyFileSync(self, dest)
  } catch { /* read-only target: the project can still reference this copy */ }
  // remember the taxonomy so later commands do not need the flag again
  writeFileSync(join(root, 'memory', '.profile.json'), JSON.stringify({ profile: p.name, version: VERSION }, null, 2) + '\n', 'utf8')
  const ignore = join(root, '.gitignore')
  const rules = ['.index.json', '.index.sqlite', '.index.sqlite-wal', '.index.sqlite-shm', '.write.lock', 'memory/.profile.json']
  const cur = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
  const missing = rules.filter((r) => !cur.split('\n').includes(r))
  if (missing.length) appendFileSync(ignore, (cur && !cur.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n', 'utf8')
  return root
}

/* ─────────────────────────── CLI ─────────────────────────── */

function argOf(argv, name, dflt = '') {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const flagOn = (argv, name) => argv.includes('--' + name)

export function main(argv = process.argv.slice(2)) {
  // `--dir` may appear anywhere on the command line; pull it out before dispatching.
  const dirFlag = argOf(argv, 'dir', '')
  const cleaned = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') { i++; continue }
    cleaned.push(argv[i])
  }
  const memDir = dirFlag ? resolve(dirFlag) : memoryDirOf()
  const cmd = cleaned[0] || 'help'
  const rest = cleaned.slice(1)
  const out = (s) => process.stdout.write(s + '\n')

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(`memory-kit ${VERSION} (DSH edition, Node only, local retrieval)\n\n` +
      '  init [dir] [--profile engineering|bili]   scaffold a memory project (default: cwd, engineering)\n' +
      '  add --type --title --summary --body-file [--scope --source --verified-at --supersedes]\n' +
      '  search "<query>" [-k 3] [--include-outdated]\n' +
      '  show <memory/...md> [--grep term] [-C 2] [--lines A-B]\n' +
      '  reindex                            rebuild the index cache and fill index.md\n' +
      '  doctor | stats | outdated [--months 6]\n\n' +
      `profiles: ${PROFILE_NAMES.join(', ')}\n` +
      `memory dir: ${memDir} (profile ${profileOf(memDir).name})`)
    return 0
  }
  if (cmd === 'init') {
    const profileName = argOf(argv, 'profile', 'engineering')
    if (!PROFILES[profileName]) {
      out(`unknown profile: ${profileName} (available: ${PROFILE_NAMES.join(', ')})`)
      return 2
    }
    // first positional that is not a flag (nor the value of a `--flag value` pair)
    const positional = []
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]
      if (a.startsWith('--')) { if (!a.includes('=')) i++; continue }
      if (a.startsWith('-')) continue
      positional.push(a)
    }
    // `--dir X init` means "initialise X"; an explicit positional still wins
    const root = initProject(positional[0] || (dirFlag ? resolve(dirFlag) : process.cwd()), { profile: profileName })
    const p = profileByName(profileName)
    out(`initialized: ${root} (profile ${p.name}, memory-kit ${VERSION})`)
    out('types: ' + Object.entries(p.types).map(([k, v]) => `${k}->${v.dir}`).join('  '))
    out('next: node memory-kit/scripts/mem.js reindex')
    return 0
  }
  if (cmd === 'add') {
    const bodyFile = argOf(argv, 'body-file', '')
    if (!bodyFile) { out('missing --body-file'); return 2 }
    try {
      const r = addEntry(memDir, {
        type: argOf(argv, 'type'),
        title: argOf(argv, 'title'),
        summary: argOf(argv, 'summary'),
        body: readFileSync(resolve(bodyFile), 'utf8'),
        scope: argOf(argv, 'scope'),
        source: argOf(argv, 'source'),
        verifiedAt: argOf(argv, 'verified-at'),
        supersedes: argOf(argv, 'supersedes'),
        noDedupe: flagOn(argv, 'no-dedupe'),
      })
      out((r.reused ? 'reused existing: ' : 'saved: ') + r.rel)
      return 0
    } catch (e) {
      out('error: ' + String(e?.message ?? e))
      return 2
    }
  }
  if (cmd === 'search') {
    const q = rest.filter((a) => !a.startsWith('-'))[0] || ''
    const shortK = argv.indexOf('-k') >= 0 ? argv[argv.indexOf('-k') + 1] : ''
    const hits = search(memDir, q, { k: Number(shortK || argOf(argv, 'k', '3')) || 3, includeOutdated: flagOn(argv, 'include-outdated') })
    out(renderSearch(q, hits))
    return 0
  }
  if (cmd === 'show') {
    const rel = String(rest[0] || '').replace(/\\/g, '/')
    if (!rel.startsWith('memory/') || rel.split('/').includes('..')) { out('only entries under memory/ are readable'); return 2 }
    const path = join(memDir, rel.split('/').join(sep))
    if (!existsSync(path)) { out('no such entry: ' + rel); return 2 }
    const lines = readFileSync(path, 'utf8').split('\n')
    const grep = argOf(argv, 'grep', '')
    const want = argOf(argv, 'lines', '')
    if (grep) {
      const ctx = Number(argOf(argv, 'C', '2')) || 0
      const idx = []
      lines.forEach((l, i) => { if (l.toLowerCase().includes(grep.toLowerCase())) idx.push(i) })
      if (!idx.length) { out('(no match)'); return 0 }
      const keep = new Set()
      for (const i of idx) for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) keep.add(j)
      out([...keep].sort((a, b) => a - b).map((i) => String(i + 1).padStart(4) + ': ' + lines[i]).join('\n'))
      return 0
    }
    if (want) {
      const [a, b] = want.split('-').map((x) => Number(x) || 1)
      out(lines.slice(Math.max(0, a - 1), b).map((l, i) => String(a + i).padStart(4) + ': ' + l).join('\n'))
      return 0
    }
    out(lines.join('\n'))
    return 0
  }
  if (cmd === 'reindex') {
    const r = reindex(memDir)
    out(`done: ${r.total} file(s), ${r.indexAdded} index line(s) added`)
    return 0
  }
  if (cmd === 'doctor') {
    const r = doctor(memDir)
    out(`memory-kit ${VERSION}: ${r.files} memory file(s)`)
    if (!r.issues.length) out('issues: 0')
    else { out(`issues: ${r.issues.length}`); for (const i of r.issues.slice(0, 40)) out('  - ' + i) }
    return r.issues.length ? 1 : 0
  }
  if (cmd === 'stats') {
    const s = stats(memDir)
    out(`memory-kit ${VERSION} (profile ${s.profile}): ${s.files} memory file(s), ${s.indexEntries} index entr(y/ies)`)
    out('types: ' + Object.entries(s.byType).map(([k, v]) => `${k}=${v}`).join(' '))
    out('status: ' + Object.entries(s.byStatus).map(([k, v]) => `${k}=${v}`).join(' '))
    return 0
  }
  if (cmd === 'outdated') {
    const months = Number(argOf(argv, 'months', '6')) || 6
    const rows = outdated(memDir, months)
    out(`effective entries untouched for ${months} month(s): ${rows.length}`)
    for (const r of rows) out(`  ${r.day}  ${r.type.padEnd(8)}  ${r.rel}`)
    return 0
  }
  out('unknown command: ' + cmd + ' (try help)')
  return 2
}

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href } catch { return false }
})()
if (isMain) process.exitCode = main()
