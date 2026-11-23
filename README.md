# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/honoka-citle/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/honoka-citle/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies an edit an AI model wrote to a tree of text files. Models write edits in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. mend reads a patch in any of those formats, finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, and indentation-insensitive), and writes every change or none of them, printing what it changed or why it failed.

This repository is an entry to the [make.fun](https://make.fun) bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Run

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Node 22 and its standard library only. The working directory is the root of the tree; PATCH is the patch file (standard input when PATCH is absent or `-`). `--format` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format). `--check` reports what would change without writing, and `--strict` matches lines exactly only.

## License

MIT — see [LICENSE](LICENSE).
