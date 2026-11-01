---
name: codebase-map
description: Visualize a repository and answer its architecture, behavior, and data questions.
disable-model-invocation: true
---

# Codebase Map

Turn an unfamiliar repository into:

1. a compact index an agent can retrieve from before reading source files;
2. a visual answer to a broad architecture question or a specific question about how the repository works.

The repository is the source of truth. Derive every concept, label, edge, and
flow from repository evidence. Never carry domain nouns, IDs, or architecture
assumptions from another repository into this run.

## Preconditions

Run this skill only when the user explicitly invokes `$codebase-map` (or the
host's equivalent command). Once invoked, treat the question in the same
request as the map's focus.

If no repository is available, ask for a folder or path and stop. Read the
repository's agent instructions before analysis. Keep production source and
existing documentation unchanged unless the user explicitly asks otherwise.

## Choose the view

- With no focus question, create the general architecture overview and the
  strongest evidence-backed end-to-end user flow.
- With a focus question, make that question the title of the focused view and
  trace the relevant code and data path.
- Match the diagram form to the question: a user journey or sequence for
  behavior, a data-flow for backend processing, an entity-relationship view
  for database structure, and a component map for architecture. For database
  views, show evidenced entities, key columns, and relationship cardinality.
- For other questions, choose the simplest diagram that explains the relevant
  evidence. A focus view may combine forms when that makes one answer clearer.
- If several paths fit, show the strongest-supported path, label its scope, and
  mention meaningful alternatives. Ask a clarifying question only when the
  choice would materially change the diagram.
- Show unsupported or inferred steps as such. Keep unknown relationships out
  of confirmed paths and list the evidence gap.

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
layer. `architecture.html` contains the general overview and the latest
focused view. Replace the previous focused view on a new question; keep the
overview and avoid accumulating old answers. `evidence.md` records claims,
sources, confidence, and gaps.

For every run, return a Mermaid diagram inline: the architecture overview when
there is no focus question, or the question-matched view when one is supplied.
Follow it with a short caption and key source paths. Use `flowchart`,
`sequenceDiagram`, or `erDiagram` to fit the question, using the same palette
and highlighted path. Link the HTML report for the interactive map.
Keep the index, context, and evidence artifacts available as support.

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
5. Trace the requested behavior or data structure from its entry point through
   the relevant components. For an unfocused run, trace the strongest
   user-visible flow.
6. Store useful inventory and evidence in `index.json`; load only compact
   context and relevant files or symbols when answering a later task.

If the repository is large, group files by boundary and retrieve by concept,
flow, file, symbol, or relationship. Do not make the agent read every file
again just because the index contains every file.

## Index model

Use the schema in [docs/index-schema.md](docs/index-schema.md).
Every material fact needs evidence and a confidence value: `confirmed`,
`inferred`, or `unknown`. Keep `schemaVersion` in the index.

Generate stable IDs from concepts discovered in the target repository. Preserve
an existing ID on refresh when its source identity is unchanged; mark removed
items stale instead of silently reusing their IDs. Do not hardcode example
domain IDs in the skill or the renderer.

## Visual contract

Render every view from the same indexed graph of concepts, relationships,
flows, and evidence. Use shared IDs across views so the diagrams cannot drift
apart.

Start from [docs/report-template.html](docs/report-template.html) and fill its
regions. It is the report contract: it carries the palette, the
cross-highlighting, and one example of every element the completion check
expects, so the shape is stated once rather than restated in prose. Where the
template stops at regions and colours, [docs/diagram-geometry.md](docs/diagram-geometry.md)
owns the coordinates that place things inside them.

The regions are the report's required shape:

- the architecture overview, with roughly 10–15 important concepts grouped by
  module or data;
- the focused view: the diagram that answers the question, or the strongest user
  flow when no question was supplied;
- the detail panel, with purpose, relationships, plain-text evidence, and
  confidence for each concept;
- the “Start here” learning path.

Use the palette the template defines: a light paper canvas with a faint grid
under each map, white tiles for nodes, ink labels centred beneath them, muted
slate connectors, and one olive accent for the requested or selected path. Show
that path with line weight and outlines as well as color, so meaning remains
clear without color alone. A node is a tile carrying a kind code with its label
below, never a logo and never a kind the evidence does not support. Use
directional arrows, system sans-serif for diagram labels, and monospace for kind
codes and source paths.

Keep the map itself prominent. Keep node labels short; place explanations and
source paths in the detail panel. Captions should fit in one or two short
sentences. Use enough contrast, visible keyboard focus, and responsive sizing.

### Fit and legibility

Place nodes, edges, and labels by the numbers in
[docs/diagram-geometry.md](docs/diagram-geometry.md): the tile and the footprint
its label makes, the character budget that keeps a label inside one, the column
and row pitch, and the rule that an arrow connects footprint boundaries and never
runs across a footprint. That file owns the values; do not restate them here or
invent variants per report.

What stays judgement:

- Choose a horizontal or vertical layout to fit the available space. Reflow or
  provide intentional pan and zoom on narrow screens so the primary path stays
  visible.
- Keep the map itself prominent; do not shrink it until it is hard to read in
  order to fit more of the repository in.
- Use consistent type sizes, weights, and line height with a clear hierarchy.
  Keep diagram labels and captions readable at their rendered size.

Every edge must have an intentional source and target from the shared graph. Add
a search control once `index.json` holds more than ten concepts. Tag every
diagram node and every detail entry with `data-concept-id`, carrying the
concept's ID from `index.json`, and keep the `#detail-…` anchor for navigation.
Selecting a concept must mark every element carrying that ID across the whole
report, not only in the view it was selected in, and reveal its relevant file or
symbol paths.

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
relationships, remove stale claims, and report changed areas. Rebuild the
focused view for the current question while preserving the general overview. A
full scan is the fallback when no prior index or usable revision exists.

## Completion check

The mechanical half of this check lives in one module. Run it when a JavaScript
runtime is available, and fix what it reports before finishing:

```text
node scripts/check-report.mjs <report-dir>
```

It verifies that the report files exist, that `index.json` is valid and carries
`schemaVersion`, that every material entry has evidence and confidence, that
every relationship, flow step, owner, and diagram `data-concept-id` resolves to a
real concept, that the report's palette matches `docs/report-template.html`, that
the diagrams obey `docs/diagram-geometry.md` — content inside the viewBox, labels
inside their footprint, no node overlap, arrows attached to footprint boundaries
and clear of every node they do not connect — that a search control is present
once the report exceeds ten concepts, that no source-code download control or
secret-shaped literal appears, and that `context.md` stays within its budget.

The rest needs judgement and cannot be decided from files:

- the inline diagram and the latest HTML focus answer the same question;
- the HTML uses the paper canvas, tiles with their labels beneath, directional
  arrows, the highlighted path, and concise captions;
- the diagram form matches the question;
- the map reads well at normal and narrow widths, where nothing looks cramped
  and the primary path still leads the eye;
- the generated context is compact enough to load before targeted retrieval;
- production source files were not changed.

A passing check is not a passing picture: a clean report can still read as
cluttered, so look at the rendered `architecture.html` before finishing, the way
you would read a diagram you had to explain from.

Report the report path, revision, focus question and diagram type, indexed
boundaries, changed areas, and known gaps.
