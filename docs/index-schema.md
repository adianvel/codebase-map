# Index schema

The schema is intentionally small. Add fields only when a real repository or
renderer needs them.

```json
{
  "schemaVersion": 1,
  "repository": {
    "name": "string",
    "revision": "string|null",
    "generatedAt": "ISO-8601 string"
  },
  "files": [
    {
      "id": "stable file id",
      "path": "repository-relative path",
      "kind": "source|test|config|docs|asset|generated",
      "summary": "short plain-language purpose",
      "symbols": ["symbol ids"],
      "evidence": ["path:line or path:symbol"],
      "confidence": "confirmed|inferred|unknown"
    }
  ],
  "concepts": [
    {
      "id": "stable semantic id",
      "name": "repository-specific display name",
      "summary": "plain-language explanation",
      "ownerFileIds": ["file ids"],
      "evidence": ["path:line or path:symbol"],
      "confidence": "confirmed|inferred|unknown"
    }
  ],
  "relationships": [
    {
      "source": "concept id",
      "target": "concept id",
      "kind": "calls|imports|routes|reads|writes|stores|references|publishes|consumes|renders|tests",
      "summary": "why the relationship matters",
      "via": ["key or join expression"],
      "cardinality": "one-to-one|one-to-many|many-to-one|many-to-many|unknown",
      "evidence": ["path:line or path:symbol"],
      "confidence": "confirmed|inferred|unknown"
    }
  ],
  "flows": [
    {
      "id": "stable flow id",
      "name": "plain-language flow name",
      "steps": ["concept ids"],
      "evidence": ["path:line or path:symbol"],
      "confidence": "confirmed|inferred|unknown"
    }
  ],
  "gaps": ["unresolved question or unsupported boundary"]
}
```

IDs are generated from the target repository's own concepts. They are not
global vocabulary and must not be copied from an example repository.

Represent database structure with evidence-backed concepts for tables,
collections, or entities and relationships such as `references`, `reads`, and
`writes`. For database relationships, put evidenced key or join expressions
in `via` and cardinality from source to target in `cardinality`; use `unknown`
when the repository cannot establish it. Omit these fields for relationships
that do not model data links; older indexes may omit them too. Use `flows` for
ordered behavior paths; use `relationships` for the data model.
