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
      "kind": "calls|imports|stores|publishes|consumes|renders|tests",
      "summary": "why the relationship matters",
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
