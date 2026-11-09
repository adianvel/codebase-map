# Glossary

Canonical domain terminology for the codebase-map project.

## Language

**Report Bundle**:
An in-memory representation of a repository map's four core artifacts (`index.json`, `architecture.html`, `context.md`, `evidence.md`), mapping filenames to their contents.
_Avoid_: Report data, report map, report object

**Report Contract**:
The mechanical specification defining valid report artifacts across palette, diagram geometry, technology marks, and index schema.
_Avoid_: Report spec, template rules, schema definition

**Report Verifier**:
The deep in-memory module that validates a Report Bundle against every mechanical invariant in the Report Contract with zero filesystem dependencies.
_Avoid_: Report checker, validation service, validator unit

**FileSystem Adapter**:
The outer adapter layer that reads a report directory from disk into a Report Bundle, loads Report Contract assets, and formats output for the terminal.
_Avoid_: CLI wrapper, disk loader, file service

**Footprint**:
The measurable unit of a diagram node (132×100px), consisting of the 60×60px tile plus its centred title and subtitle labels underneath.
_Avoid_: Node bounds, tile area, label box

**Diagram Model**:
The structured in-memory representation of an architectural SVG diagram (viewBox, nodes with footprint and technology marks, segmented edges, and labels) extracted from `architecture.html`.
_Avoid_: SVG AST, diagram DOM, diagram tree
