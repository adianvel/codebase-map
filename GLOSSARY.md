# Glossary

Canonical domain terminology for the codebase-map project.

### Report Artifacts

- **Report Bundle**: An in-memory representation of a repository map's four core artifacts (`index.json`, `architecture.html`, `context.md`, `evidence.md`), mapping filenames to their contents.
- **Report Contract**: The mechanical specification defining valid report artifacts across `docs/report-template.html` (palette and structure), `docs/diagram-geometry.md` (geometry and footprint rules), `docs/technology-marks.json` (technology marks), and `docs/index-schema.md` (index schema).

### Architecture & Verification

- **Report Verifier**: The deep in-memory module (`verifyReport`) that validates a Report Bundle against every mechanical invariant in the Report Contract.
- **FileSystem Adapter**: The outer adapter layer (`checkReport`, `cli`) that reads a report directory from disk into a Report Bundle, handles filesystem errors, and formats output for the terminal.
- **Footprint**: The measurable unit of a diagram node (132×100px), consisting of the 60×60px tile plus its centred title and subtitle labels underneath.
