---
name: codebase-map
description: Build a repository-grounded codebase index and an interactive monochrome visual map with connected architecture, user-flow, and evidence views. Use when someone asks to understand, map, visualize, tour, or explain how a repository works.
---

# Codebase Map

Turn an unfamiliar repository into two useful things:

1. a compact index an agent can retrieve from before reading source files;
2. an interactive, hand-drawn-style visual map a human can learn from.

The repository is the source of truth. Derive every concept, label, edge, and
flow from repository evidence. Never carry domain nouns, IDs, or architecture
assumptions from another repository into this run.

## Preconditions

If no repository is available, ask for a folder or path and stop. Read the
repository's agent instructions before analysis. Keep production source and
existing documentation unchanged unless the user explicitly asks otherwise.

## Artifact contract

Create or refresh a report under:

```text
reports/codebase-map/<repository-name>/
├── index.json
├── context.md
├── architecture.html
└── evidence.md
```

`index.json` is the source of truth. `context.md` is the compact orientation
layer. `architecture.html` is the human-facing interactive view. `evidence.md`
records claims, sources, confidence, and gaps.

Keep the report local and self-contained. Do not upload repository contents,
load secrets, expose environment values, or add source-code download controls.
Show evidence as plain text such as `path/to/file.ts:42 — symbolName()`.

## Scan without wasting context

Scan the repository locally, but do not load the whole repository into the
agent prompt:

1. Read instructions, README files, manifests, lockfiles, and configuration.
2. Inventory relevant tracked files with Git when available; otherwise walk the
   filesystem with explicit exclusions for dependencies, build output, caches,
   generated artifacts, binaries, and secret files.
3. Identify runtime boundaries, entry points, routes, commands, workers,
   schemas, persistence, external services, tests, and deployment boundaries.
4. Extract lightweight file, symbol, import, route, schema, and test facts.
5. Trace the most central user-visible flow supported by evidence.
6. Store the complete useful inventory in `index.json`; load only the compact
   context and the relevant files/symbols when answering a later task.

If the repository is large, group files by boundary and retrieve by concept,
flow, file, symbol, or relationship. Do not make the agent read every file
again just because the index contains every file.

## Index model

Use the schema in [references/index-schema.md](references/index-schema.md).
Every material fact needs evidence and a confidence value: `confirmed`,
`inferred`, or `unknown`. Keep `schemaVersion` in the index.

Generate stable IDs from concepts discovered in the target repository. Preserve
an existing ID on refresh when its source identity is unchanged; mark removed
items stale instead of silently reusing their IDs. Do not hardcode example
domain IDs in the skill or the renderer.

## Visual contract

Render every view from the same indexed graph of concepts, relationships,
flows, and evidence. Use shared IDs across all views so the diagrams cannot
drift apart.

The default visual language is black and white with a restrained hand-drawn
feel:

- white background, black text, thin black lines, and generous whitespace;
- readable handwritten-style labels at normal weight;
- subtle sketch imperfections on borders and paths, while text and arrows stay
  crisp and readable;
- use line weight, outlines, and patterns for selection or uncertainty instead
  of bright colors;
- no characters, decorative illustrations, gradients, dense legends, or giant
  dependency hairballs;
- short node labels; explanations belong in the detail panel.

The HTML should provide:

- an architecture overview;
- the most useful end-to-end user flow;
- grouped module/boundary exploration;
- search and progressive drill-down;
- cross-highlighting when the same concept appears in multiple views;
- a detail panel with purpose, relationships, plain-text evidence, and
  confidence;
- a short “Start here” learning path.

Every edge must have an intentional source and target from the shared graph.
Selecting a concept in one view must highlight that same ID everywhere else.
Keep the default overview to roughly 10–15 important concepts and reveal the
rest through interaction.

## Agent-facing context

Write `context.md` as a small orientation document containing only:

- repository purpose and runtime shape;
- major boundaries and entry points;
- important user-visible flows;
- key concepts and their ownership;
- useful files to read first;
- unresolved questions and confidence notes.

Keep file- and symbol-level detail in `index.json`. When a user asks for an
implementation change, consult `context.md`, retrieve the relevant index
nodes, then inspect the supporting source slices. Do not inject the complete
repository or complete index into context by default.

## Refresh

Record the current revision when Git is available. On refresh, compare the
current inventory with the previous index, update affected summaries and
relationships, remove stale claims, and report changed areas. A full scan is
the fallback when no prior index or usable revision exists.

## Completion check

Before reporting completion, verify:

- the index is valid and has `schemaVersion`;
- every material claim has evidence and confidence;
- all visual views use the same concept IDs;
- every edge points to a real concept;
- the HTML is interactive, readable, monochrome, and self-contained;
- no source-code download UI or secret value is present;
- the generated context is compact enough to load before targeted retrieval;
- production source files were not changed.

Report the report path, revision, selected flow, indexed boundaries, changed
areas, and known gaps.
