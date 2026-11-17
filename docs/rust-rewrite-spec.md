# Rust rewrite of the report check

Status: implemented on branch `rust-rewrite`.

## Grilling, answered from the repository

The owner was away, so the usual interview was answered from the repo's own
evidence instead of stalling.

- **What is "executable" in this skill?** Only the report check. Mapping a
  repository is agent work guided by `SKILL.md`; there is no scanner, indexer,
  or report generator script. The scripts are `check-report.mjs` (FileSystem
  Adapter), `report-verifier.mjs` (Report Verifier) and `diagram-model.mjs`
  (Diagram Model), plus `test/check-report.test.mjs` and the CI workflow.
  So "rewrite into Rust" means: rewrite the report check, keep everything else.
- **Does the output format change?** No. Agents never write a different
  `index.json`, `context.md`, `evidence.md`, or `architecture.html`; the Rust
  check must accept and reject exactly what the Node check did, with the same
  error text, the same order, and the same exit codes (0 pass, 1 problems,
  2 usage or missing directory).
- **Where do the Report Contract assets come from?** The Node check read
  `docs/report-template.html`, `docs/technology-marks.json` and
  `docs/diagram-geometry.json` next to the script. The Rust binary embeds the
  same files at compile time (`include_str!`), so one static binary carries
  its contract and cargo rebuilds it whenever an asset changes. The docs stay
  the single home of every number and colour.
- **Keep the Node scripts?** No. Parity is proven by a golden corpus recorded
  from the Node verifier (every call the old test suite made) that the Rust
  tests replay, plus a one-off differential run of both CLIs over a mutation
  corpus. After that the Node code is deleted (git history keeps it), so there
  are not two verifiers to drift apart.
- **What if the agent has no Rust toolchain?** Same rule as before when no
  JavaScript runtime was available: the mechanical check is skipped and the
  judgement half of the completion check still applies.

## Problem Statement

The codebase-map skill's completion check needs Node.js. The owner wants the
skill's executable part in Rust: a single fast binary with no runtime.

## Solution

A cargo crate at the repo root builds one binary, `check-report`:

```text
check-report <report-dir>
```

It behaves exactly like `node scripts/check-report.mjs <report-dir>`.

## User Stories

1. As an agent finishing a map, I want to run one binary on the report
   directory, so that I can fix mechanical problems before handing it over.
2. As an agent, I want the same error messages as before, so that the guidance
   in `SKILL.md` and `docs/diagram-geometry.md` still matches what I see.
3. As a maintainer, I want the binary to carry the Report Contract assets, so
   that the check cannot run against a mismatched template.
4. As a maintainer, I want CI to build, lint, format-check and test the crate
   and run it over the example report on every push.
5. As a maintainer, I want a parity test against recorded Node results, so
   that the rewrite is proven equivalent instead of claimed.

## Implementation Decisions

- Modules mirror the glossary: Report Verifier (pure, in-memory; takes a
  Report Bundle and the resolved contract assets, returns the error list),
  Diagram Model (extracts viewBox, nodes, edges, labels from the HTML), and
  the FileSystem Adapter (the binary: reads the directory, formats output).
- The Report Bundle is a JSON value (file name to contents), as in Node, so
  the recorded corpus replays without translation, including odd inputs such
  as a non-object bundle or an `index.json` given as an object.
- JavaScript semantics that leak into messages are reproduced: number
  formatting (`120`, `37.5`, `NaN`), `String(value)` and `JSON.stringify` of
  bad values, `parseFloat` prefixes, and ASCII `\b` and `\d`.
- Regexes the Rust `regex` crate cannot express (lookahead) are rewritten as
  equivalent plain code.
- Crates: `regex`, `serde_json` (with `preserve_order`, so index text is
  walked in the same key order as Node). No CLI framework: one positional
  argument does not need clap.

## Testing Decisions

- Seams: (1) the library's `verify_report(bundle, contract)`, the same seam
  the Node tests used; (2) the binary's exit code and output.
- Tests port the Node suite's intent at seam (1), replay the 53-case golden
  corpus at seam (1), and drive the built binary at seam (2).

## Out of Scope

- Generating maps (the agent does that), new checks, a new output format.
- Prebuilt release binaries for every platform.

## Tickets (tracer bullets)

- [x] 1. Crate skeleton and CLI: usage, missing directory, missing files,
  pass on the example report. (no blockers)
- [x] 2. `index.json` schema and reference checks. (blocked by 1)
- [x] 3. `architecture.html` concept markers, search control, download
  control, palette. (blocked by 1)
- [x] 4. Diagram Model and layout checks. (blocked by 1)
- [x] 5. Technology mark checks, secrets, context budget. (blocked by 2, 4)
- [x] 6. Golden parity corpus replay and differential run vs Node.
  (blocked by 2-5)
- [x] 7. Switch SKILL.md, README, CI to the binary; delete the Node scripts.
  (blocked by 6)

## Verification record

- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`: clean.
- `cargo test`: 28 tests (unit: JavaScript formatting and the Diagram Model;
  integration: CLI, verifier behaviour, and the 53-case Node replay).
- Differential run, Node `scripts/check-report.mjs` at 4561b09 against the
  release binary, comparing exit code, stdout and stderr: the example report,
  the 35 recorded bundles that used the default contract, and 25,000 seeded
  mutations of them (five seeds of 5,000). No difference in any report Node
  could check. The only differences:
  - 363 reports where an `index.json` entry was `null` or not an object: Node
    crashed with a `TypeError`; Rust reports the entry's missing fields.
  - 1 report with a 2.7 GB `context.md`: Node could not read a string that
    large and called the file missing; Rust reads it and reports the budget.
  - By design: the usage line names `check-report`, and an invalid
    `index.json` names serde's syntax error instead of V8's.
