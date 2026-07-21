# Pipedrive MCP Server

A single-tenant, self-hosted Model Context Protocol server for Pipedrive. Version 2.x uses Pipedrive API v2 for deals, persons, organizations, pipelines, stages, leads, and item search. Notes and users remain isolated behind clearly scoped v1 adapters because Pipedrive has not moved those APIs to v2.

The server is read-only by default. Two narrowly scoped write tools can be enabled explicitly and remain preview-first.

## Requirements

- Node.js 22 or 24 (Node 24 recommended)
- A Pipedrive API token

`PIPEDRIVE_DOMAIN` is not used. The official Pipedrive client supplies the API base URL.

## Install and run with stdio

Install globally:

```bash
npm install --global pipedrive-mcp-server
PIPEDRIVE_API_TOKEN=your-token pipedrive-mcp-server
```

Or build this repository:

```bash
npm ci
npm run check
PIPEDRIVE_API_TOKEN=your-token npm start
```

Example desktop MCP configuration:

```json
{
  "mcpServers": {
    "pipedrive": {
      "command": "pipedrive-mcp-server",
      "env": {
        "PIPEDRIVE_API_TOKEN": "your-token"
      }
    }
  }
}
```

## Streamable HTTP

The modern HTTP endpoint defaults to `http://127.0.0.1:3000/mcp`:

```bash
PIPEDRIVE_API_TOKEN=your-token \
MCP_TRANSPORT=http \
pipedrive-mcp-server
```

`GET /health` is unauthenticated, host-validated, and returns only service status. The server creates an independent MCP server and transport for every session and closes active sessions during shutdown.

Binding to a non-loopback address requires both an HS256 JWT secret of at least 32 characters and an explicit hostname allowlist:

```bash
PIPEDRIVE_API_TOKEN=your-token \
MCP_TRANSPORT=http \
MCP_HOST=0.0.0.0 \
MCP_ALLOWED_HOSTS=mcp.example.com \
MCP_ALLOWED_ORIGINS=https://app.example.com \
MCP_JWT_SECRET='replace-with-at-least-32-random-characters' \
pipedrive-mcp-server
```

The built-in HTTP server does not terminate TLS. Never expose it directly on an untrusted network: place it behind a trusted HTTPS reverse proxy, keep the application port private, and configure the proxy to replace (not append to) forwarding headers. JWT bearer tokens are replayable if captured. Docker Compose therefore publishes the service only on host loopback by default; remote operators must add a TLS terminator before changing that binding.

Clients send `Authorization: Bearer <token>`. Tokens must use HS256. `MCP_JWT_ISSUER` and `MCP_JWT_AUDIENCE` add optional claim validation. There is no boot-token setting.

`MCP_ALLOWED_ORIGINS` is an exact, comma-separated allowlist. When it is empty the server emits no CORS headers; wildcard CORS is not supported. `MCP_ALLOWED_HOSTS` contains hostnames only, without schemes, paths, or ports.

## Legacy SSE

The deprecated compatibility routes are `GET /sse` and `POST /messages`. They are enabled by default in 2.x and can be disabled with `MCP_ENABLE_LEGACY_SSE=false`. `MCP_TRANSPORT=sse` remains an alias for HTTP mode and emits a warning. These routes are planned for removal in 3.0.

## Docker

Copy `.env.example` to `.env`, set `PIPEDRIVE_API_TOKEN`, and set a random `MCP_JWT_SECRET` of at least 32 characters. Then run:

```bash
docker compose up --build -d
docker compose ps
```

Compose serves `/mcp` on port 3000, requires JWT for MCP routes, runs as the unprivileged `node` user, and checks `/health` with Node’s built-in `fetch`. Published images use `ghcr.io/willdent/pipedrive-mcp-server`.

For stdio in Docker, override the transport and disable the HTTP health check:

```bash
docker run --rm -i --no-healthcheck \
  -e PIPEDRIVE_API_TOKEN=your-token \
  -e MCP_TRANSPORT=stdio \
  ghcr.io/willdent/pipedrive-mcp-server:latest
```

## Tools and response contract

Read tools:

- `get-users`
- `get-deals`, `get-deal`, `get-deal-notes`, `search-deals`
- `get-persons`, `get-person`, `search-persons`
- `get-organizations`, `get-organization`, `search-organizations`
- `get-pipelines`, `get-pipeline`, `get-stages`
- `search-leads`, `search-all`

List/search tools return JSON text and structured content shaped as:

```json
{
  "items": [],
  "count": 0,
  "nextCursor": "optional-cursor",
  "truncated": false,
  "filters": {}
}
```

Single-record tools return `{ "item": {} }`. Stable failures return `{ "code", "message", "retryable" }` with MCP `isError: true`; raw API errors, credentials, and token-bearing URLs are not exposed.

`get-deals` has no hidden status or activity-date defaults. It supports owner, stage, pipeline, status, updated-time, value, cursor, limit, and generic custom-field selection. Page size defaults to 100 and is capped at 500. Value filtering scans at most 2,000 deals and reports `truncated` and `nextCursor` when more records remain. Use `search-deals` for title searches.

## Gated writes

No write tools are registered unless named in `PIPEDRIVE_WRITE_TOOLS`:

```bash
PIPEDRIVE_WRITE_TOOLS=move-deal,add-deal-note
```

- `move-deal` requires `dealId`, `targetStageId`, and `expectedCurrentStageId`. It performs a best-effort optimistic stale-state check immediately before the update. Pipedrive does not expose an atomic conditional stage update, so concurrent changes by another client can still race this check.
- `add-deal-note` accepts at most 10,000 characters of plain text and HTML-escapes it before sending.
- Both tools preview by default. A mutation happens only with `execute: true`.
- Audit output contains only operation, entity ID, outcome, and timestamp—never note contents or credentials.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PIPEDRIVE_API_TOKEN` | required | Pipedrive API token |
| `MCP_TRANSPORT` | `stdio` | `stdio`, `http`, or deprecated `sse` alias |
| `MCP_HOST` | `127.0.0.1` | HTTP bind address |
| `MCP_PORT` | `3000` | HTTP port |
| `MCP_HTTP_PATH` | `/mcp` | Streamable HTTP path |
| `MCP_ALLOWED_HOSTS` | local hosts | Exact hostname allowlist |
| `MCP_ALLOWED_ORIGINS` | empty | Exact CORS origin allowlist |
| `MCP_ENABLE_LEGACY_SSE` | `true` | Keep `/sse` and `/messages` |
| `MCP_MAX_SESSIONS` | `100` | Maximum combined HTTP/SSE sessions |
| `MCP_SESSION_IDLE_TIMEOUT_MS` | `1800000` | Close sessions idle longer than this duration |
| `MCP_JWT_SECRET` | empty | HS256 secret; required off loopback |
| `MCP_JWT_ISSUER` | empty | Optional JWT issuer |
| `MCP_JWT_AUDIENCE` | empty | Optional JWT audience |
| `PIPEDRIVE_WRITE_TOOLS` | empty | Explicit write-tool allowlist |
| `PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS` | `250` | Minimum delay between queued calls |
| `PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT` | `2` | Maximum concurrent calls |

All ports, paths, numeric limits, origins, hosts, boolean values, and tool names are validated at startup.

## Migrating from 1.x

1. Upgrade Node to 22 or 24.
2. Remove `PIPEDRIVE_DOMAIN`, `MCP_JWT_TOKEN`, `MCP_JWT_ALGORITHM`, and `MCP_ENDPOINT`.
3. Replace HTTP `MCP_TRANSPORT=sse` with `MCP_TRANSPORT=http`; keep the alias temporarily if a client still uses legacy SSE.
4. Point modern clients at `/mcp`; legacy clients may use `/sse` through 2.x.
5. Update callers for cursor pagination and the structured response contract.
6. Review deal queries: `get-deals` no longer silently forces open status or a 365-day activity window.
7. Leave `PIPEDRIVE_WRITE_TOOLS` empty until each write has been reviewed and sandbox-tested.

## Development and release

```bash
npm run typecheck
npm test
npm run build
npm run validate:package
```

See [docs/release-checklist.md](docs/release-checklist.md) for automated, Docker, and manual Pipedrive sandbox gates. Releases are tag-driven and use npm trusted publishing plus GHCR semantic tags.

## Scope

Version 2.x remains single-tenant and self-hosted. Pipedrive OAuth, MCP OAuth, persistent sessions, broad CRUD, and destructive delete tools are intentionally out of scope.

## License

MIT
