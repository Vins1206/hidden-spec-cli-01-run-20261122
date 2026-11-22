# mend

One CLI that applies AI-written edits in four formats to a tree of text
files, exactly as `SPEC.md` (version 1) in the make.fun kit says:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- **unified** diffs (often with wrong line numbers — hunks are matched by
  content, nearest to the hunk's line number)
- **SEARCH/REPLACE** blocks
- **V4A** patches (`*** Begin Patch` ... `*** End Patch`, with anchors,
  a cursor, and `*** End of File` chunks)
- **JSON** text-editor tool calls (`create`, `str_replace`, `insert`)

Lines an edit names are found at the first of three matching tiers
(exact; trailing whitespace ignored; leading and trailing whitespace
ignored), unless `--strict` asks for exact only. At tier 2, added lines
are re-indented from the patch's indentation to the file's. Every file
is changed or none is: a failed edit is reported, the edits after it
still run, and when any edit failed nothing is written.

Node 22, standard library alone — nothing is installed before the
program runs. `runner.ts` is the kit's trial runner, kept as shipped.

Built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/c/hidden-spec-cli-01-run-20261122).
