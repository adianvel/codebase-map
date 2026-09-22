# Tiny app fixture

This deliberately generic fixture represents a small application boundary:

```text
request → handler → repository → database
                    └──────────→ worker
```

It contains no project-specific vocabulary. Use it to forward-test the skill's
indexing, evidence, shared IDs, and connected visual views.
