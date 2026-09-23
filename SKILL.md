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
`sequenceDiagram`, or `erDiagram` to fit the question, using the same dark
palette and highlighted path. Link the HTML report for the interactive map.
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

Use the visual language from the linked diagram reference:

- dark charcoal canvas (`#17191D`) with slightly raised node surfaces
  (`#22262B`);
- clear off-white labels (`#E7EBF0`), muted secondary text (`#A3ABB6`), and
  subdued slate connectors (`#626B77`);
- one lime accent (`#C9F36B`) for the requested or selected path;
- compact labeled boxes, directional arrows, and short captions;
- system sans-serif for diagram labels and monospace for source paths;
- use line weight and outlines as well as color to show the selected path, so
  meaning remains clear without color alone.

Keep the map itself prominent. Keep node labels short; place explanations and
source paths in the detail panel. Captions should fit in one or two short
sentences. Use enough contrast, visible keyboard focus, and responsive sizing.

### Fit and legibility

- Include every node, arrow, label, and caption inside the diagram bounds; size
  the SVG viewBox or canvas to the complete drawing.
- Choose a horizontal or vertical layout to fit the available space. Reflow or
  provide intentional pan and zoom on narrow screens so the primary path stays
  visible.
- Align nodes to a consistent grid with even spacing. Keep arrows attached to
  their endpoints and route them clear of text; prevent collisions and overlap.
- Let boxes grow or wrap labels instead of clipping text. Shorten canvas labels
  and move extra detail into the selection panel; do not shrink the whole map
  until it is hard to read.
- Use consistent type sizes, weights, and line height with a clear hierarchy.
  Keep diagram labels and captions readable at their rendered size.

The HTML should provide:

- a general architecture overview with roughly 10–15 important concepts;
- the latest question-focused diagram, or the strongest user flow when no
  question was supplied;
- grouped module or data boundaries;
- search and progressive drill-down;
- cross-highlighting when a concept appears in multiple views;
- a detail panel with purpose, relationships, plain-text evidence, and
  confidence;
- a short “Start here” learning path.

Every edge must have an intentional source and target from the shared graph.
Selecting a concept in one view must highlight the same ID everywhere else and
reveal its relevant file or symbol paths.

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

Before reporting completion, verify:

- the index is valid and has `schemaVersion`;
- every material claim has evidence and confidence;
- all visual views use the same concept IDs;
- every edge points to a real concept;
- the inline diagram and latest HTML focus answer the same question;
- the HTML uses the dark canvas, compact boxes, directional arrows, highlighted
  path, concise captions, and remains self-contained and readable;
- no node, edge, label, or caption is cut off, clipped, overlapped, or misaligned;
- when a visual preview is available, inspect the diagram at normal and narrow
  widths; otherwise check that the SVG or canvas bounds contain the full drawing;
- no source-code download UI or secret value is present;
- the generated context is compact enough to load before targeted retrieval;
- production source files were not changed.

Report the report path, revision, focus question and diagram type, indexed
boundaries, changed areas, and known gaps.
