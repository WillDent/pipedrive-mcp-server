# Release checklist

Do not tag a release until every applicable item is complete. A passing automated suite does not replace the Pipedrive sandbox checks.

## Automated gates

- [ ] CI passes on Node 22 and Node 24.
- [ ] `npm run check` passes.
- [ ] `npm pack --dry-run` passes and the packed executable validation succeeds.
- [ ] The Docker image builds, runs as `node`, and becomes healthy.
- [ ] Dependency audit findings are reviewed and documented.
- [ ] An independent security review covers authentication, HTTP session isolation, CORS, Host validation, shutdown, and secret handling.
- [ ] GitHub environments named `npm` and `release` have required-reviewer protection configured before a tag is pushed.

## Pipedrive sandbox: 2.0 read foundation

- [ ] A default `get-deals` call includes current visible deals and deals with no `last_activity_date`.
- [ ] Owner, pipeline, stage, status, `updatedSince`, and `updatedUntil` filters return expected deals.
- [ ] Value filters respect the 2,000-record scan cap and report truncation honestly.
- [ ] Cursor pagination works across deals, contacts, organizations, pipelines, stages, leads, item search, and notes.
- [ ] Deal, person, and organization searches return expected records.
- [ ] Generic custom field selection works without tenant-specific field hashes.
- [ ] stdio initializes and calls tools successfully.
- [ ] Streamable HTTP initializes, isolates two simultaneous sessions, and shuts both down cleanly.
- [ ] Legacy `/sse` and `/messages` still work when enabled and return 404 when disabled.
- [ ] Invalid JWTs, origins, and Host headers are rejected; `/health` reveals no configuration.
- [ ] Any non-loopback deployment is behind a trusted TLS terminator and the application port is not directly exposed.

## Publish and closeout

- [ ] Tag `v2.0.0`, verify npm/GitHub/GHCR artifacts, then close issue #1 with the diagnosis and migration link.
- [ ] Confirm GHCR tags for the release: full version, minor line, major line, and `latest`.
