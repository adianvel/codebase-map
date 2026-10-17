# Tiny app fixture

This small TypeScript fixture demonstrates an asynchronous request path:
handler → repository → database, with a worker event after successful reads.

## Sample codebase-map output

The included [interactive report](reports/codebase-map/tiny-app/architecture.html)
answers: “How does a request read a record?”

It contains a repository overview, the focused request flow, and the evidence
used to build each view:

- [index.json](reports/codebase-map/tiny-app/index.json)
- [context.md](reports/codebase-map/tiny-app/context.md)
- [evidence.md](reports/codebase-map/tiny-app/evidence.md)

The fixture has no database schema. The report calls that out instead of
inventing tables or relationships.
