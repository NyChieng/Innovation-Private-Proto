## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Which layer

<!-- Tick one. If you are ticking more than one, see "When a change spans two
     layers" in the README - it is usually two pull requests, backend first. -->

- [ ] `FloraScan-Web-App/` — the web app
- [ ] `Server/` — the API
- [ ] `plant_registry_schema.sql` / `scripts/` — schema and seed data
- [ ] shared files at the root (needs NY's review)

## Tested

- [ ] `npm test` passes — both suites, against my own database
- [ ] I added or updated a check for what this changes
- [ ] I stayed inside my layer's folder

<!-- If a suite fails for a reason you believe is unrelated, say which check
     and why here rather than leaving it unticked with no explanation. -->

## Does this change the API contract?

<!-- A new endpoint, a renamed field, a different status code, a new required
     body parameter. If yes, say exactly what - this is what the connectivity
     check looks at, and the other layer has to be told. If no, write "no". -->

## Does this change the database?

<!-- A new table or column, a changed constraint, a new setting. If yes, say
     whether `npm run db:setup -- --reset` is needed, because everyone else
     will have to run it. If no, write "no". -->
