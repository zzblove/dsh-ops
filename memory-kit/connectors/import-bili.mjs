#!/usr/bin/env node
/**
 * import-bili.mjs — turn "dsh-bili-scroll" watched-video ledgers into memory entries.
 * ============================================================================
 * The DSH plugin dsh-bili-scroll keeps a plain-text ledger at
 *   <duty-home>/seen.md
 * with two tables: a comment log and a "videos seen" table whose rows look like
 *
 *   | 2026-10-26 | BV1xxxxxxxxx | Title | Uploader | picked |
 *
 * This connector reads those rows and writes one `fact` per day into the memory
 * project, so a chat session can ask "what did I watch last week" through
 * `mem.js search` instead of parsing the plugin's format.
 *
 * Default is a dry run. Pass --apply to write. Duplicates are handled by the
 * memory kit's own dedupe, so re-running is safe.
 *
 * Usage:
 *   node memory-kit/connectors/import-bili.mjs [--duty-home DIR] [--since-days 7] [--apply] [--dir MEMORY_DIR]
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { addEntry, memoryDirOf } from '../scripts/mem.js'

const argOf = (argv, name, dflt = '') => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const flagOn = (argv, name) => argv.includes('--' + name)

export const BVID = /BV[0-9A-Za-z]{10}/

/** Parse the "videos seen" table into row objects. Tolerant of extra columns. */
export function parseSeenTable(text) {
  const rows = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('|') || /^\|\s*-+/.test(line)) continue
    const cells = line.split('|').map((c) => c.trim()).slice(1, -1)
    const bi = cells.findIndex((c) => BVID.test(c))
    if (bi < 0) continue
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(cells[bi - 1] || '')?.[1] || ''
    if (!day) continue
    rows.push({
      day,
      bvid: BVID.exec(cells[bi])[0],
      title: cells[bi + 1] || '',
      up: cells[bi + 2] || '',
      status: cells[cells.length - 1] || '',
    })
  }
  return rows
}

const isPicked = (status) => !/skip|skipped|not picked/i.test(status) && /pick|kept|watch|worth/i.test(status)
const isSkipped = (status) => /skip|skipped|not picked/i.test(status)

/** Group rows by day and render one memory entry body per day. */
export function groupByDay(rows, sinceDays = 7) {
  const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString().slice(0, 10)
  const byDay = new Map()
  for (const r of rows) {
    if (r.day < cutoff) continue
    if (!byDay.has(r.day)) byDay.set(r.day, [])
    byDay.get(r.day).push(r)
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, list]) => {
      const picked = list.filter((r) => isPicked(r.status) && !isSkipped(r.status))
      const skipped = list.filter((r) => isSkipped(r.status))
      const body = [
        `## ${day}`,
        '',
        picked.length ? 'Picked:' : 'Picked: none',
        ...picked.map((r) => `- ${r.bvid} · ${r.title || '(no title)'} · ${r.up || '(unknown uploader)'} · https://www.bilibili.com/video/${r.bvid}`),
        '',
        skipped.length ? 'Skipped:' : 'Skipped: none',
        ...skipped.map((r) => `- ${r.bvid} · ${r.title || '(no title)'} · reason: ${r.status}`),
      ].join('\n')
      return {
        day,
        picked: picked.length,
        skipped: skipped.length,
        title: `Bilibili round-up ${day}`,
        summary: `${picked.length} picked / ${skipped.length} skipped`,
        body,
      }
    })
    .filter((d) => d.picked > 0 || d.skipped > 0)
}

function main() {
  const argv = process.argv.slice(2)
  const dutyHome = resolve(argOf(argv, 'duty-home', join(homedir(), '.dsh', 'bili-duty')))
  const sinceDays = Number(argOf(argv, 'since-days', '7')) || 7
  const apply = flagOn(argv, 'apply')
  const memDir = argOf(argv, 'dir', '') ? resolve(argOf(argv, 'dir')) : memoryDirOf()

  const seenFile = join(dutyHome, 'seen.md')
  if (!existsSync(seenFile)) {
    console.log(`nothing to import: ${seenFile} does not exist yet (run one round first)`)
    return 0
  }
  const rows = parseSeenTable(readFileSync(seenFile, 'utf8'))
  const days = groupByDay(rows, sinceDays)
  console.log(`ledger: ${seenFile}`)
  console.log(`rows: ${rows.length} total, ${days.length} day(s) within ${sinceDays} day(s)`)
  if (!days.length) {
    console.log('nothing to import: no rows in range (an empty ledger is normal before the first round).')
    return 0
  }
  let written = 0
  let reused = 0
  for (const d of days) {
    if (!apply) {
      console.log(`[dry-run] would add: ${d.title} — ${d.summary}`)
      continue
    }
    const r = addEntry(memDir, {
      type: 'fact',
      title: d.title,
      summary: d.summary,
      body: d.body,
      scope: 'bilibili',
      source: `seen.md @ ${seenFile}`,
    })
    if (r.reused) reused++
    else written++
    console.log(`${r.reused ? 'reused' : 'saved'}: ${r.rel}`)
  }
  if (!apply) console.log('dry run only — pass --apply to write these entries.')
  else console.log(`done: ${written} new, ${reused} reused, memory dir ${memDir}`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('import-bili.mjs')) {
  process.exitCode = main()
}
