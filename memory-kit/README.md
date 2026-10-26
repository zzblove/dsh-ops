# memory-kit — long-term memory for DSH projects

A **DSH-oriented edition** of [markdown-project-memory](https://github.com/zzblove/markdown-project-memory)
(MIT): the same Markdown-is-the-source-of-truth protocol, reimplemented in **Node only**.

## Why a rewrite

A DSH plugin or a headless round may have **no Python** available (common on Windows), but it always
has Node. This keeps the protocol identical — same `memory/` layout, same frontmatter, same
`memory/index.md` format — so a project can use either implementation against the same directory.

Deliberately dropped (kept out of DSH's daily path, avoids network and keys):

- embeddings / rerank / any cloud API — retrieval is **local keyword only**
- the HTTP service, eval harness, handoff bundles, and `annotate`

## Layout

```
memory-kit/
├─ scripts/mem.js              CLI + library (search/show/add/reindex/doctor/stats/outdated)
├─ connectors/import-bili.mjs  turn dsh-bili-scroll's seen.md ledger into memory entries
├─ test/mem.test.mjs           regression suite (no network)
├─ AGENTS.snippet.md           protocol block to paste into a project's AGENTS.md
└─ README.md / README.zh.md
```

A memory project itself is just:

```
<project>/
├─ memory/index.md             append-only entry list
├─ memory/facts/               environment facts
├─ memory/decisions/           decisions with rationale
├─ memory/howto/               working step-by-step procedures
└─ .gitignore                  ignores .index.json / .write.lock
```

## Quick start

```console
node memory-kit/scripts/mem.js init                       # scaffold ./ (or pass a directory)
node memory-kit/scripts/mem.js add --type fact --title "DSH home" \
  --summary "under the user home by default" --body-file body.md --scope dsh
node memory-kit/scripts/mem.js search "dsh home" -k 3
node memory-kit/scripts/mem.js reindex                    # rebuild .index.json, fill index.md
node memory-kit/scripts/mem.js doctor                     # metadata / index drift
```

The memory directory defaults to `memory-kit/`'s parent; override with `MEMORY_DIR` or `--dir`
anywhere on the command line.

## Commands

| Command | Purpose |
| --- | --- |
| `init [dir]` | idempotently scaffold a memory project |
| `add --type --title --summary --body-file` | append an entry (write-locked, deduplicated); `--scope`, `--source`, `--verified-at`, `--supersedes` (corrections) |
| `search "<query>" [-k N] [--include-outdated]` | local keyword retrieval; prints candidates with path, line range and excerpt |
| `show <memory/...md> [--grep t] [-C n] [--lines A-B]` | read the original; only paths under `memory/` are allowed |
| `reindex` | rebuild the derived index cache and fill missing `index.md` lines |
| `doctor` | missing fields, duplicate titles, dangling `supersedes`, index drift |
| `stats` | counts by type and status |
| `outdated [--months N]` | effective entries not updated for N months |

## Protocol (unchanged from the upstream edition)

- **Types**: `fact` (environment truth), `decision` (with rejected options), `howto` (steps that
  worked), `correction` (rewrites an earlier entry via `supersedes`).
- **One topic per file**, named `YYYY-MM-DD-HHMM-<slug>-<random8>.md`, with frontmatter
  `date / created_at / status / type / summary` plus optional `scope / source / verified_at /
  supersedes`.
- **`index.md` is append-only**; `add` appends the index line under the same write lock, so readers
  never see a half-written state.
- **Dedupe**: byte-identical active entries are reused instead of duplicated.
- **Corrections** flip the old entry to `status: outdated` and keep its body and date intact.
- Never store secrets, credentials, or temporary debugging output.

## DSH integration

### dsh-bili-scroll (the "watch Bilibili" plugin)

The plugin writes a plain-text ledger of what it watched to `<duty-home>/seen.md`
(default `~/.dsh/bili-duty/seen.md`). Two ways to make those videos retrievable from a chat session:

1. **Import the ledger into memory** (recommended, no plugin change needed):

   ```console
   node memory-kit/connectors/import-bili.mjs --since-days 7            # dry run
   node memory-kit/connectors/import-bili.mjs --since-days 7 --apply    # write entries
   ```

   One `fact` per day (`Bilibili round-up YYYY-MM-DD`) with picked/skipped videos and links.
   Re-running is safe: the kit's dedupe reuses identical entries.

2. **Point the plugin at this directory**: set `长期记忆目录 / memory dir` in the plugin settings to
   this memory project's root. The plugin then searches it locally before every round and may append
   at most two observations per round.

### Any DSH project

Paste `AGENTS.snippet.md` into the project's `AGENTS.md` so every agent session reads and writes the
same `memory/` directory.

## Differences from the Python edition

| Area | Python edition | This edition |
| --- | --- | --- |
| Runtime | Python 3.10+ | Node 18+ (no dependencies) |
| Retrieval | keyword + optional embedding/rerank | keyword only, always offline |
| Correction prefix | `更正：` | `Correction: ` |
| `index.md` header | Chinese heading | `# Memory index` |
| Extra tooling | HTTP service, eval, handoff, annotate | not included |

Shared on purpose: directory layout, frontmatter keys, `index.md` line format, dedupe/correction
semantics, and the `.write.lock` name — so both editions can operate on one project.

## Tests

```console
node memory-kit/test/mem.test.mjs
```

Covers frontmatter parsing (including JSON values written by the Python edition), scaffolding
idempotency, add/dedupe/validation, corrections, retrieval (CJK + ASCII, outdated handling, `k`
cap), reindex/doctor/stats/outdated, the write lock (including stale-lock takeover), cross-edition
interop, and the Bilibili ledger connector.

## License and attribution

MIT. Derived from [zzblove/markdown-project-memory](https://github.com/zzblove/markdown-project-memory);
the protocol and Markdown layout originate there.
