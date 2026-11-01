# codebase-map

Turn an unfamiliar repository into a compact agent context and a visual map
that answers questions about its structure, behavior, and data.

> Repository-grounded index | question-focused diagrams | interactive map |
> evidence attached to every path

## What this is

`codebase-map` is a user-invoked skill for people who want to understand a
repository visually. Invoke it with no question for a general overview, or name
a question such as a user journey, backend request, or database structure.
The skill traces the relevant source and answers with a diagram.

The index is the source of truth. Inline diagrams and the interactive HTML map
are views of the same evidence-backed graph.

## Who it is for

Good fit for:

- developers onboarding to an unfamiliar codebase;
- visual learners who understand systems faster through connected diagrams;
- people asking how a user journey, backend request, or database is organized;
- agents that need compact repository context before implementing changes;
- teams that want architecture and user-flow documentation grounded in source;
- codebases that need a repeatable map refreshed after changes.

Not a fit for:

- generating decorative product illustrations;
- replacing source code, tests, or formal API documentation;
- dumping the whole repository into an agent prompt;
- producing a static diagram disconnected from the underlying evidence;
- assuming one business domain or programming language.

## What it produces

For a target repository, the skill creates or refreshes:

```text
reports/codebase-map/<repository-name>/
├── index.json        # machine-readable source of truth
├── context.md        # compact agent orientation
├── architecture.html # interactive human-facing map
└── evidence.md       # claims, sources, confidence, and gaps
```

The HTML view keeps the general architecture overview and the latest
question-focused diagram. A new question replaces the previous focused view;
the overview remains. The skill returns the matching diagram inline with a
short caption, and everything is rendered from
[docs/report-template.html](docs/report-template.html), so the outline, the
focused view, and the evidence details stay one connected graph rather than a
picture of one.

Which diagram you get follows your question — a flow, sequence, or
entity-relationship view, whichever makes the answer clearest.

The repository is scanned locally, but the agent receives compact context and
targeted source slices instead of the entire repository or entire index.

## Example

A question-focused view highlights the path that answers the user's question.
Inline Mermaid needs literal colours, so these mirror the palette that
[docs/report-template.html](docs/report-template.html) defines:

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#F6F7F9","primaryColor":"#FFFFFF","primaryTextColor":"#1B2028","primaryBorderColor":"#8A94A3","lineColor":"#8A94A3","fontFamily":"system-ui"}}}%%
flowchart TB
    user["User"] --> web["Web App"]
    web --> api["API Layer"]
    api --> core["Core Logic"]
    core --> db["Database"]

    api --> worker["Background Worker"]
    worker --> external["External Service"]

    classDef node fill:#FFFFFF,stroke:#8A94A3,color:#1B2028;
    classDef focus fill:#F0F6E2,stroke:#4D7C0F,stroke-width:2px,color:#1B2028;
    class user,web,api,core,db focus;
    class worker,external node;
    linkStyle 0,1,2,3 stroke:#4D7C0F,stroke-width:2.5px;
```

The highlighted route answers the focus question; nearby systems stay visible
as context.

The generated `architecture.html` uses the same indexed graph, so the
architecture overview, focused diagram, and evidence details stay connected.

## Installation

Copy the skill bundle into the skills directory supported by your agent:

```text
<agent-skills-directory>/codebase-map/
├── SKILL.md
├── docs/
│   ├── diagram-geometry.md
│   ├── index-schema.md
│   └── report-template.html
└── scripts/
    └── check-report.mjs
```

The user must invoke it by name using the convention supported by the agent:

```text
$codebase-map
```

After invocation, include a natural-language question in the same request:

```text
Use $codebase-map to show how a user request moves through the backend.
```

The skill is designed to work across Codex, Claude Code, and other agents that
support reusable repository skills. It does not require an MCP server, hosted
database, image-generation service, or parser package.

The report check ships as a zero-dependency Node script. CI runs it over the
example report, and the agent runs it before finishing when a JavaScript runtime
is available; mapping a repository does not require one.

## Usage

Create a first map:

```text
Use $codebase-map to show how a user signs in.
Trace the user journey through the frontend, backend, and database. Return the
diagram inline and include the source paths in the interactive report.
```

Refresh an existing map:

```text
Use $codebase-map to refresh the repository map after the latest changes.
Highlight changed boundaries, stale relationships, and unresolved gaps.
```

Retrieve context for implementation:

```text
Use $codebase-map to find the files and symbols involved in adding [change].
Explain the relevant flow before proposing an implementation.
```

## How a run works

A run reads the repository's instructions and manifests, inventories tracked
files, identifies the entry points, routes, schemas, and workers it finds, traces
the flow your question names, then writes the four artifacts. `SKILL.md` owns the
sequence and the contract; this is the summary.

On refresh, the skill uses the current Git revision when available, updates
affected summaries and relationships, and removes stale claims instead of
silently preserving them.

## Design principles

- one shared graph drives every diagram and explanation;
- stable IDs keep repeated concepts connected across views and refreshes;
- the user's question chooses the focused diagram and its level of detail;
- evidence and confidence separate facts from architectural inference;
- progressive disclosure keeps large repositories readable;
- full local scanning does not mean full prompt injection;
- source files and existing documentation remain unchanged by default;
- outputs stay local and never expose secrets or environment values.

## Repository structure

```text
.
├── SKILL.md
├── README.md
├── LICENSE
├── docs/
│   ├── diagram-geometry.md
│   ├── index-schema.md
│   └── report-template.html
├── scripts/
│   └── check-report.mjs
├── .github/
│   └── workflows/
│       └── check.yml
└── examples/
    └── tiny-app/
        ├── README.md
        ├── handler.ts
        ├── repository.ts
        ├── database.ts
        ├── worker.ts
        └── reports/
            └── codebase-map/
                └── tiny-app/
                    ├── index.json
                    ├── context.md
                    ├── architecture.html
                    └── evidence.md
```

The tiny fixture is intentionally domain-neutral. It exists to forward-test
indexing, evidence, stable IDs, and connected visual views.

## Notes

The rules that used to be listed here — label length, the overview size target,
the search threshold, plain-text evidence, the no-download rule, and when to add
a parser helper — are stated once in `SKILL.md`, which owns the contract. The
report's shape and palette live in `docs/report-template.html`, and
`scripts/check-report.mjs` enforces the mechanical parts. CI runs that module over
the example report on every push and pull request.

## License

MIT. See [LICENSE](LICENSE).
