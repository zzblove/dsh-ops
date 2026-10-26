# Long-term memory (`memory/`)

This project keeps long-term memory as Markdown: Markdown is the source of truth, the index is a
derived cache. Any agent session reads and writes the same `memory/` directory.

## Read (first action)

1. `node memory-kit/scripts/mem.js search "<task keywords>"` — local keyword retrieval, no network,
   at most 3 candidates by default; use `-k 5` for more.
2. Candidates are for triage only. Before quoting numbers, paths or conclusions, reopen the original:
   `node memory-kit/scripts/mem.js show memory/<...>.md --grep "<term>" -C 2`.
3. No result means no relevant memory — do not force a low-score candidate. Fall back to reading
   `memory/index.md` or grepping `memory/` directly.
4. Code and the user's words outrank memory. When memory conflicts with what you observe now, trust
   the present and write a `correction`.

## Write (when a durable conclusion forms)

- Types depend on the project's profile (`memory/.profile.json`):
  - `engineering`: `fact` (environment truth) · `decision` (choice plus rejected options) · `howto` (steps that worked)
  - `bili`: `taste` (likes/avoids, tone) · `video` (takeaway from one video) · `talk` (conclusion or promise from a conversation) · `creator` (uploaders/people)
  - both: `correction` (rewrite an earlier entry via `--supersedes`; it lands next to the corrected entry)
- One topic per file. Always go through the CLI so the write lock, dedupe and index stay consistent:

  ```console
  node memory-kit/scripts/mem.js add --type fact --title "<topic>" \
    --summary "<one line>" --body-file body.md --scope <area> --source "<evidence>" \
    [--confidence stated|inferred]
  ```

- **State the confidence**: `--confidence stated` (default) means the user said it; use
  `--confidence inferred` for anything you derived yourself. Inferred memory is flagged in search output
  and must be presented as a guess, never as something the user said.
- Re-run `node memory-kit/scripts/mem.js reindex` afterwards.
- Never store secrets, credentials, temporary debugging output, or anything already obvious from the
  code. Do not copy a whole session log into memory.

## Maintain

- `doctor` for metadata/index drift, `outdated --months 6` for stale entries, `stats` for totals.
- Merge entries on the same topic (keep the evolution), mark superseded ones `outdated`, and only
  delete transient or already-corrected content. Never delete decisions.
