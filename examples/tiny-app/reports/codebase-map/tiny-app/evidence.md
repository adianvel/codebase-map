# Evidence

## Focus: How does a request read a record?

- <code>handleRequest</code> accepts an id, calls <code>repository.find</code>,
  and returns status 200 or 404 — confirmed by handler.ts:3-5.
- <code>repository.find</code> calls <code>database.read</code>, publishes a
  <code>record.read</code> event when the returned record is present, then
  returns the record — confirmed by repository.ts:5-8.
- <code>database.read</code> returns a fixture record for every id — confirmed
  by database.ts:2-3. The 404 branch exists in the handler but this database
  stub does not exercise it.
- <code>worker.publish</code> accepts and returns the event — confirmed by
  worker.ts:2-3.

## Known gaps

- No schema file or database entity definitions exist in this fixture. There
  is no evidence for tables, keys, cardinality, or stored relationships.
