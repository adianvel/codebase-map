# Tiny app

This fixture shows one request path: <code>handleRequest</code> looks up an id
through the repository and database. When a record is present, the repository
publishes a <code>record.read</code> event to the worker.

## Start here

1. handler.ts — request input and status response.
2. repository.ts — database read and conditional worker event.
3. database.ts — fixture data behavior.

The fixture contains no database schema, so table structure and key
relationships are unknown.
