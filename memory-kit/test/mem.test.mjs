// memory-kit regression suite (no network):
//   node memory-kit/test/mem.test.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VERSION, TYPES, parseDoc, loadDocs, isActive, tokenize, scoreDoc, search, renderSearch,
  addEntry, markOutdated, reindex, doctor, stats, outdated, initProject, withLock, memoryDirOf, indexPath,
} from '../scripts/mem.js'

const fail = []
let total = 0
const ok = (cond, msg) => { total++; if (!cond) fail.push(msg) }
const roots = []
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'mk-')); roots.push(d); return d }
const fresh = () => { const d = mk(); initProject(d); return d }

// 1. frontmatter parsing, including JSON values written by the Python edition
{
  const p = parseDoc('---\ndate: 2026-10-26\nstatus: active\ntype: fact\nsummary: "summary with \\"quotes\\""\nsupersedes: ["memory/facts/a.md"]\n---\n\n# Title A\n\nbody\n')
  ok(p.meta.date === '2026-10-26', 'date not parsed')
  ok(p.meta.summary === 'summary with "quotes"', 'JSON-quoted value not decoded: ' + p.meta.summary)
  ok(Array.isArray(p.meta.supersedes) && p.meta.supersedes[0] === 'memory/facts/a.md', 'supersedes array not parsed')
  ok(p.title === 'Title A', 'title not parsed')
  const noFm = parseDoc('# Only title\n\nbody')
  ok(noFm.title === 'Only title' && !noFm.meta.date, 'missing frontmatter must not throw')
}

// 2. initProject is idempotent and creates the expected layout
{
  const d = fresh()
  ok(existsSync(join(d, 'memory', 'facts')), 'memory/facts missing')
  ok(existsSync(join(d, 'memory', 'decisions')) && existsSync(join(d, 'memory', 'howto')), 'decisions/howto missing')
  ok(readFileSync(indexPath(d), 'utf8').startsWith('# Memory index'), 'index.md header wrong')
  const gi = readFileSync(join(d, '.gitignore'), 'utf8')
  ok(gi.includes('.write.lock') && gi.includes('.index.json'), '.gitignore misses derived files')
  initProject(d)
  ok(gi.trim().split('\n').length === readFileSync(join(d, '.gitignore'), 'utf8').trim().split('\n').length,
    'initProject is not idempotent (.gitignore appended twice)')
}

// 3. add: on-disk shape, index line, dedupe, validation
{
  const d = fresh()
  const a = { type: 'fact', title: 'Where DSH home is', summary: 'under the user home by default', body: 'Windows: %USERPROFILE%\\.dsh; macOS: ~/.dsh.', scope: 'dsh', source: 'measured' }
  const r1 = addEntry(d, a)
  ok(!r1.reused && r1.rel.startsWith('memory/facts/') && r1.rel.endsWith('.md'), 'wrong path/dir: ' + r1.rel)
  const text = readFileSync(r1.path, 'utf8')
  ok(text.startsWith('---\ndate: ') && text.includes('\nstatus: active\n') && text.includes('\ntype: fact\n'), 'frontmatter incomplete')
  ok(text.includes('summary: "under the user home by default"'), 'summary not JSON encoded')
  ok(text.includes('\n# Where DSH home is\n'), 'body misses the level-1 heading')
  ok(readFileSync(indexPath(d), 'utf8').includes('`' + r1.rel + '`'), 'index.md was not updated')

  const r2 = addEntry(d, a)
  ok(r2.reused && r2.rel === r1.rel, 'byte-identical duplicate was not reused: ' + JSON.stringify(r2))
  ok(throws(() => addEntry(d, { type: 'nope', title: 't', summary: 's', body: 'b' })), 'invalid type accepted')
  ok(throws(() => addEntry(d, { type: 'correction', title: 't', summary: 's', body: 'b' })), 'correction without supersedes accepted')
  ok(throws(() => addEntry(d, { type: 'fact', title: '', summary: 's', body: 'b' })), 'empty title accepted')
}

// 4. correction: prefix, outdated flag on the old entry, body preserved
{
  const d = fresh()
  const old = addEntry(d, { type: 'fact', title: 'Memory dir is A', summary: 'path A', body: 'old conclusion: A' })
  const fix = addEntry(d, { type: 'correction', title: 'Memory dir moved to B', summary: 'path B', body: 'new conclusion: B; evidence: migration log', supersedes: old.rel })
  ok(fix.rel.startsWith('memory/facts/'), 'correction should land under facts/')
  const fixed = readFileSync(fix.path, 'utf8')
  ok(fixed.includes('# Correction: Memory dir moved to B'), 'correction title is not prefixed')
  ok(fixed.includes('supersedes: "' + old.rel + '"'), 'correction does not record supersedes')
  const before = readFileSync(old.path, 'utf8')
  ok(before.includes('status: outdated'), 'old entry was not marked outdated')
  ok(before.includes('old conclusion: A'), 'old entry body was modified')
  ok(before.includes('updated: '), 'old entry has no updated stamp')
}

// 5. retrieval: CJK + ASCII, outdated exclusion, k cap, empty result wording
{
  const d = fresh()
  addEntry(d, { type: 'fact', title: 'How to install a DSH plugin', summary: 'use dsh plugin add', body: 'command: dsh plugin --profile desktop add xxx', scope: 'dsh' })
  addEntry(d, { type: 'decision', title: 'Dedupe rule for watched videos', summary: 'dedupe by BV id', body: 'never by title similarity; a renamed video is still the same BV.', scope: 'bilibili' })
  const stale = addEntry(d, { type: 'fact', title: 'Old config no longer used', summary: 'old', body: 'marked outdated; default search must not return it.' })
  markOutdated(d, stale.rel, '2026-10-26')

  const h1 = search(d, 'BV dedupe', { k: 3 })
  ok(h1.length === 1 && h1[0].doc.rel.includes('watched videos'), 'mixed CJK/ASCII query missed: ' + JSON.stringify(h1.map((x) => x.doc.rel)))
  const h2 = search(d, 'dsh plugin', { k: 3 })
  ok(h2.some((x) => x.doc.title.includes('install a DSH plugin')), 'ASCII query missed')
  const h3 = search(d, 'Old config', {})
  ok(!h3.some((x) => x.doc.rel === stale.rel), 'outdated entry returned by default')
  const h4 = search(d, 'Old config', { includeOutdated: true })
  ok(h4.some((x) => x.doc.rel === stale.rel), '--include-outdated ignored')
  ok(search(d, 'zzzqqq-no-such-term', {}).length === 0, 'unrelated query returned candidates')
  ok(renderSearch('q', []).includes('no relevant memory'), 'empty result does not say "no relevant memory"')
  ok(search(d, 'memory plugin dedupe watched', { k: 1 }).length <= 1, 'k was not honoured')
}

// 6. tokenizer and scoring
{
  const t = tokenize('DSH plugin 插件')
  ok(t.includes('dsh') && t.includes('插件'), 'tokenizer dropped terms: ' + t.join(','))
  const doc = { title: 'title mentions dsh', meta: { summary: '' }, body: 'body body' }
  ok(scoreDoc(doc, ['dsh']) > scoreDoc(doc, ['absent']), 'title hit does not score higher')
}

// 7. reindex / doctor / stats / outdated
{
  const d = fresh()
  addEntry(d, { type: 'howto', title: 'How to run one round', summary: 'click the button', body: 'settings page -> run one round.' })
  writeFileSync(join(d, 'memory', 'howto', '2026-01-01-0000-handwritten-aaaaaaaa.md'),
    '---\ndate: 2026-01-01\nstatus: active\ntype: howto\nsummary: "handwritten"\n---\n\n# Handwritten entry\n\nbody\n', 'utf8')
  const r = reindex(d)
  ok(r.total === 2 && r.indexAdded === 1, 'reindex counts wrong: ' + JSON.stringify(r))
  ok(existsSync(join(d, '.index.json')), 'reindex did not write .index.json')
  ok(doctor(d).issues.length === 0, 'doctor reported issues on a healthy project: ' + JSON.stringify(doctor(d).issues))
  const s = stats(d)
  ok(s.files === 2 && s.byType.howto === 2, 'stats wrong: ' + JSON.stringify(s))
  ok(Array.isArray(outdated(d, 1)), 'outdated should return an array')
  writeFileSync(join(d, 'memory', 'facts', 'bad.md'), 'no frontmatter and no title\n', 'utf8')
  ok(doctor(d).issues.length >= 2, 'doctor missed a broken entry: ' + JSON.stringify(doctor(d).issues))
}

// 8. write lock: released on success, stale lock taken over
{
  const d = fresh()
  ok(withLock(d, () => 42) === 42, 'withLock did not return the callback result')
  ok(!existsSync(join(d, '.write.lock')), 'withLock did not release the lock')
  writeFileSync(join(d, '.write.lock'), '999999@2020-01-01T00:00:00.000Z', 'utf8')
  const t0 = Date.now()
  ok(withLock(d, () => 'taken') === 'taken', 'stale lock was not taken over')
  ok(Date.now() - t0 < 3000, 'taking over a stale lock took too long (' + (Date.now() - t0) + 'ms)')
  ok(!existsSync(join(d, '.write.lock')), 'own lock not released after takeover')
}

// 9. interoperability with the Python edition over the same memory/
{
  const d = fresh()
  const pyFile = join(d, 'memory', 'facts', '2026-10-26-1502-Written by python-2e5abdfc.md')
  writeFileSync(pyFile, '---\ndate: 2026-10-26\ncreated_at: 2026-10-26T15:02:00\nstatus: active\ntype: fact\nsummary: "summary written by python"\nscope: "bilibili"\n---\n\n# Written by python\n\nbody mentions dedupe and BV ids.\n', 'utf8')
  const hits = search(d, 'dedupe BV', { k: 3 })
  ok(hits.length === 1, 'cannot read an entry written by the Python edition')
  ok(hits[0].doc.meta.scope === 'bilibili', 'scope not parsed from the Python edition')
  const first = [...loadDocs(d).values()][0]
  ok(isActive(first), 'active detection wrong')
  ok(memoryDirOf({ MEMORY_DIR: d }) === d, 'MEMORY_DIR override ignored')
}

// 12. directory profiles: the same CLI serves a different taxonomy per project
{
  const { profileOf, typesOf, PROFILES, profileByName } = await import('../scripts/mem.js')
  const eng = fresh()
  ok(profileOf(eng).name === 'engineering', 'project without .profile.json should default to engineering')
  ok(typesOf(eng).join(',') === 'fact,decision,howto,correction', 'engineering types changed: ' + typesOf(eng).join(','))

  const bili = mk()
  initProject(bili, { profile: 'bili' })
  ok(profileOf(bili).name === 'bili', '.profile.json not honoured')
  ok(typesOf(bili).join(',') === 'taste,video,talk,creator,correction', 'bili types wrong: ' + typesOf(bili).join(','))
  for (const dir of ['taste', 'videos', 'talks', 'creators']) {
    ok(existsSync(join(bili, 'memory', dir)), `bili profile did not create memory/${dir}`)
  }
  ok(!existsSync(join(bili, 'memory', 'facts')), 'bili profile should not create engineering dirs')

  const t1 = addEntry(bili, { type: 'taste', title: 'Prefers short videos', summary: 'under 30 minutes', body: 'The user skips anything longer than 30 minutes.' })
  ok(t1.rel.startsWith('memory/taste/'), 'taste entry landed in the wrong dir: ' + t1.rel)
  const v1 = addEntry(bili, { type: 'video', title: 'BV1xx takeaway', summary: 'worth a rewatch', body: 'Explains the flaky test root cause.' })
  ok(v1.rel.startsWith('memory/videos/'), 'video entry landed in the wrong dir: ' + v1.rel)
  const c1 = addEntry(bili, { type: 'correction', title: 'BV1xx takeaway was wrong', summary: 'not worth a rewatch', body: 'The root cause was actually the cache.', supersedes: v1.rel })
  ok(c1.rel.startsWith('memory/videos/'), '@target correction should sit next to the corrected entry: ' + c1.rel)
  ok(throws(() => addEntry(bili, { type: 'fact', title: 'x', summary: 'y', body: 'z' })), 'bili project accepted an engineering type')
  try { addEntry(bili, { type: 'fact', title: 'x', summary: 'y', body: 'z' }) } catch (e) {
    ok(/taste \/ video \/ talk \/ creator \/ correction/.test(String(e.message)), 'error message should list the profile types: ' + e.message)
  }
  ok(throws(() => addEntry(eng, { type: 'taste', title: 'x', summary: 'y', body: 'z' })), 'engineering project accepted a bili type')
  ok(PROFILES.bili.types.correction.dir === '@target', 'bili correction should be @target')
  ok(profileByName('nope').name === 'engineering', 'unknown profile should fall back to engineering')
  ok(stats(bili).profile === 'bili', 'stats should report the profile')
}

// 10. constants
{
  ok(TYPES.join(',') === 'fact,decision,howto,correction', 'type list changed')
  ok(/^\d+\.\d+\.\d+$/.test(VERSION), 'VERSION is not semver')
}

// 11. bilibili connector: parses the plugin ledger and groups it by day
{
  const { parseSeenTable, groupByDay } = await import('../connectors/import-bili.mjs')
  const today = new Date().toISOString().slice(0, 10)
  const ledger = [
    '## Comment log',
    '',
    '| BV | rpid | root | time | excerpt |',
    '| --- | --- | --- | --- | --- |',
    `| BV1aaaaaaaaa | 317831597441 | 0 | ${today} 10:00 | hello |`,
    '',
    '## Videos seen',
    '',
    `| ${today} | BV1bbbbbbbbb | A picked video | Uploader A | picked |`,
    `| ${today} | BV1ccccccccc | A skipped one | Uploader B | skipped, no subtitle |`,
    `| 2020-01-01 | BV1ddddddddd | Ancient row | Uploader C | picked |`,
  ].join('\n')
  const rows = parseSeenTable(ledger)
  ok(rows.length === 3, 'ledger parser should only read the videos-seen table, got ' + rows.length)
  ok(rows[0].bvid === 'BV1bbbbbbbbb' && rows[0].up === 'Uploader A', 'row fields misparsed: ' + JSON.stringify(rows[0]))
  const days = groupByDay(rows, 7)
  ok(days.length === 1 && days[0].picked === 1 && days[0].skipped === 1, 'grouping wrong: ' + JSON.stringify(days.map((d) => [d.day, d.picked, d.skipped])))
  ok(days[0].title.includes(today) && days[0].body.includes('https://www.bilibili.com/video/BV1bbbbbbbbb'), 'entry body incomplete')
  ok(groupByDay(rows, 7).every((d) => d.day !== '2020-01-01'), '--since-days cutoff ignored')
}

function throws(fn) {
  try { fn(); return false } catch { return true }
}

for (const d of roots) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }

if (fail.length) {
  console.error(`FAIL memory-kit self-check (${fail.length}/${total}):`)
  for (const f of fail) console.error('  - ' + f)
  process.exit(1)
}
console.log(`ok memory-kit (${total} assertions, v${VERSION})`)
