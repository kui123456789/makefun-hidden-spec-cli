[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kui123456789/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kui123456789/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
# mend

Apply an AI-written edit to a tree of text files — one command-line tool for
every format models write edits in.

Models write edits in four formats: a unified diff (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. `mend` reads all four to one written specification
(`SPEC.md`), finds the lines an edit names even when the model drifted their
whitespace or indentation, and changes every file or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Exit codes and output

- Exit 2, one line, on a usage error (`error: usage`), an unreadable patch
  file (`error: no-patch`), an undetectable format (`error: format`), or a
  patch that cannot be read in its format (`error: parse <N>`).
- Exit 1, nothing written: one `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then
  `failed: <k> of <n> edits`. Edits after a failed one still run, so every
  failure is reported.
- Exit 0: one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>`
  for a move), then `ok: <n> files` (or `ok: 1 file`).

## Matching

Old lines are found at the first of three tiers at which they occur at least
once: exact match, then ignoring trailing spaces and tabs, then ignoring
leading and trailing spaces and tabs. A unified hunk takes the occurrence
nearest to its (possibly wrong) line number; a SEARCH/REPLACE block fails as
`ambiguous` when its old lines occur more than once; a V4A chunk works from
a cursor and an anchor line. Context lines are always written as the file's
own matched lines, and at tier 2 new lines are re-indented to the file's
indentation.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner, kept as shipped.
- `check.ts` — runs `main.ts` on the kit's practice set.
- `SPEC.md` — the full specification this tool implements.

## Practice score

100 of 100 practice checks pass (practice score 1000), verified with:

```
node check.ts <practice.json>
```

## License

MIT. See `LICENSE`.
