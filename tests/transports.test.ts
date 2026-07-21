import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import jwt from "jsonwebtoken";
import { createMcpServer } from "../src/server.js";
import { startHttpServer } from "../src/transports.js";
import { FakeGateway, httpConfig } from "./helpers.js";

function rawRequest(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path, headers: { Host: host } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("Streamable HTTP supports MCP initialization and rejects bad hosts", async () => {
  const gateway = new FakeGateway();
  const running = await startHttpServer(httpConfig(), () => createMcpServer({ gateway, version: "test" }));
  const client = new Client({ name: "http-test", version: "test" });
  try {
    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", transport: "http" });

    const badHost = await rawRequest(running.port, "/health", "evil.example");
    assert.equal(badHost.status, 403);

    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)));
    const tools = await client.listTools();
    assert.equal(tools.tools.some(tool => tool.name === "get-deals"), true);
  } finally {
    await client.close().catch(() => undefined);
    await running.close();
  }
});

test("JWT-protected HTTP rejects unauthenticated MCP requests", async () => {
  const running = await startHttpServer(httpConfig({
    jwt: { secret: "x".repeat(32) }
  }), () => createMcpServer({ gateway: new FakeGateway(), version: "test" }));
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    assert.equal(response.status, 401);
  } finally {
    await running.close();
  }
});

test("HTTP enforces exact CORS origins and omits CORS when unconfigured", async () => {
  const running = await startHttpServer(httpConfig({ allowedOrigins: ["https://app.example.com"] }), () =>
    createMcpServer({ gateway: new FakeGateway(), version: "test" })
  );
  try {
    const allowed = await fetch(`http://127.0.0.1:${running.port}/health`, {
      headers: { Origin: "https://app.example.com" }
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(allowed.headers.get("access-control-expose-headers"), "MCP-Session-Id");

    const rejected = await fetch(`http://127.0.0.1:${running.port}/health`, {
      headers: { Origin: "https://evil.example" }
    });
    assert.equal(rejected.status, 403);
  } finally {
    await running.close();
  }

  const noCors = await startHttpServer(httpConfig(), () =>
    createMcpServer({ gateway: new FakeGateway(), version: "test" })
  );
  try {
    const response = await fetch(`http://127.0.0.1:${noCors.port}/health`);
    assert.equal(response.headers.has("access-control-allow-origin"), false);
  } finally {
    await noCors.close();
  }
});

test("JWT accepts only valid HS256 issuer and audience claims", async () => {
  const secret = "x".repeat(32);
  const running = await startHttpServer(httpConfig({
    jwt: { secret, issuer: "issuer", audience: "audience" }
  }), () => createMcpServer({ gateway: new FakeGateway(), version: "test" }));
  const endpoint = `http://127.0.0.1:${running.port}/mcp`;
  const request = (token: string) => fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "invalid", params: {} })
  });
  try {
    const wrongAlgorithm = jwt.sign({ aud: "audience" }, secret, { algorithm: "HS384", issuer: "issuer" });
    assert.equal((await request(wrongAlgorithm)).status, 401);

    const wrongAudience = jwt.sign({ aud: "other" }, secret, { algorithm: "HS256", issuer: "issuer" });
    assert.equal((await request(wrongAudience)).status, 401);

    const valid = jwt.sign({ aud: "audience" }, secret, { algorithm: "HS256", issuer: "issuer" });
    assert.notEqual((await request(valid)).status, 401);
  } finally {
    await running.close();
  }
});

test("legacy SSE remains compatible when enabled", { timeout: 5_000 }, async () => {
  const running = await startHttpServer(httpConfig(), () =>
    createMcpServer({ gateway: new FakeGateway(), version: "test" })
  );
  const client = new Client({ name: "legacy-test", version: "test" });
  try {
    await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${running.port}/sse`)));
    const tools = await client.listTools();
    assert.equal(tools.tools.some(tool => tool.name === "get-deals"), true);
  } finally {
    await client.close().catch(() => undefined);
    await running.close();
  }
});

test("legacy SSE routes return 404 when disabled", async () => {
  const running = await startHttpServer(httpConfig({ legacySseEnabled: false }), () =>
    createMcpServer({ gateway: new FakeGateway(), version: "test" })
  );
  try {
    assert.equal((await fetch(`http://127.0.0.1:${running.port}/sse`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${running.port}/messages`, { method: "POST" })).status, 404);
  } finally {
    await running.close();
  }
});

test("failed HTTP initialization is cleaned up without consuming capacity", async () => {
  const running = await startHttpServer(httpConfig({
    httpSessions: { maximum: 1, idleTimeoutMs: 1_800_000 }
  }), () => createMcpServer({ gateway: new FakeGateway(), version: "test" }));
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "malformed-client", version: "test" }
        }
      })
    });
    assert.equal(response.status, 406);
    assert.equal(running.activeSessionCount(), 0);
  } finally {
    await running.close();
  }
});

test("HTTP session capacity is enforced and idle sessions expire", { timeout: 5_000 }, async () => {
  const running = await startHttpServer(httpConfig({
    httpSessions: { maximum: 1, idleTimeoutMs: 1_000 }
  }), () => createMcpServer({ gateway: new FakeGateway(), version: "test" }));
  const first = new Client({ name: "capacity-first", version: "test" });
  const blocked = new Client({ name: "capacity-blocked", version: "test" });
  const replacement = new Client({ name: "capacity-replacement", version: "test" });
  try {
    await first.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)));
    await assert.rejects(
      blocked.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`))),
      /Session capacity reached/
    );
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await replacement.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)));
    assert.equal(running.activeSessionCount(), 1);
  } finally {
    await first.close().catch(() => undefined);
    await blocked.close().catch(() => undefined);
    await replacement.close().catch(() => undefined);
    await running.close();
  }
});

test("concurrent HTTP initializations cannot bypass session capacity", { timeout: 5_000 }, async () => {
  const running = await startHttpServer(httpConfig({
    httpSessions: { maximum: 1, idleTimeoutMs: 1_800_000 }
  }), () => createMcpServer({ gateway: new FakeGateway(), version: "test" }));
  const first = new Client({ name: "concurrent-first", version: "test" });
  const second = new Client({ name: "concurrent-second", version: "test" });
  try {
    const results = await Promise.allSettled([
      first.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`))),
      second.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)))
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.equal(running.activeSessionCount(), 1);
  } finally {
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
    await running.close();
  }
});

test("HTTP sessions use independent MCP server instances and close cleanly", { timeout: 5_000 }, async () => {
  let serverCount = 0;
  const running = await startHttpServer(httpConfig(), () => {
    serverCount += 1;
    return createMcpServer({ gateway: new FakeGateway(), version: "test" });
  });
  const first = new Client({ name: "first", version: "test" });
  const second = new Client({ name: "second", version: "test" });
  try {
    await first.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)));
    await second.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)));
    assert.equal(serverCount, 2);
    assert.equal(running.activeSessionCount(), 2);
    await running.close();
    assert.equal(running.activeSessionCount(), 0);
  } finally {
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
  }
});

test("stdio entrypoint completes an MCP handshake", { timeout: 5_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: process.cwd(),
    env: { PIPEDRIVE_API_TOKEN: "test-token", MCP_TRANSPORT: "stdio" },
    stderr: "pipe"
  });
  const client = new Client({ name: "stdio-test", version: "test" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some(tool => tool.name === "get-deals"), true);
  } finally {
    await client.close().catch(() => undefined);
  }
});
