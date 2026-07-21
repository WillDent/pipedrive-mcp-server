import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { getPackageVersion } from "../src/version.js";

test("loadConfig defaults to secure local stdio", () => {
  const config = loadConfig({ PIPEDRIVE_API_TOKEN: "token" });
  assert.equal(config.transport, "stdio");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.jwt, undefined);
});

test("legacy sse is an HTTP alias and enables the bridge", () => {
  const config = loadConfig({ PIPEDRIVE_API_TOKEN: "token", MCP_TRANSPORT: "sse" });
  assert.equal(config.transport, "http");
  assert.equal(config.legacySseAlias, true);
  assert.equal(config.legacySseEnabled, true);
});

test("blank optional JWT values are treated as unset", () => {
  const config = loadConfig({
    PIPEDRIVE_API_TOKEN: "token",
    MCP_JWT_SECRET: "",
    MCP_JWT_AUDIENCE: "",
    MCP_JWT_ISSUER: ""
  });
  assert.equal(config.jwt, undefined);
});

test("remote HTTP requires JWT and allowed hosts", () => {
  assert.throws(
    () => loadConfig({ PIPEDRIVE_API_TOKEN: "token", MCP_TRANSPORT: "http", MCP_HOST: "0.0.0.0" }),
    /MCP_JWT_SECRET/
  );
  assert.throws(
    () => loadConfig({
      PIPEDRIVE_API_TOKEN: "token",
      MCP_TRANSPORT: "http",
      MCP_HOST: "0.0.0.0",
      MCP_JWT_SECRET: "x".repeat(32)
    }),
    /MCP_ALLOWED_HOSTS/
  );
});

test("HTTP paths, hosts, origins, and booleans are validated", () => {
  assert.throws(
    () => loadConfig({ PIPEDRIVE_API_TOKEN: "token", MCP_HTTP_PATH: "/health" }),
    /reserved server path/
  );
  assert.throws(
    () => loadConfig({ PIPEDRIVE_API_TOKEN: "token", MCP_ALLOWED_HOSTS: "https:\/\/example.com" }),
    /Invalid MCP_ALLOWED_HOSTS/
  );
  assert.throws(
    () => loadConfig({ PIPEDRIVE_API_TOKEN: "token", MCP_ALLOWED_ORIGINS: "*" }),
    /Invalid MCP_ALLOWED_ORIGINS/
  );
  assert.throws(
    () => loadConfig({ PIPEDRIVE_API_TOKEN: "token", MCP_ENABLE_LEGACY_SSE: "sometimes" }),
    /boolean/
  );
});

test("package version loads from metadata and falls back safely", () => {
  const directory = mkdtempSync(join(tmpdir(), "pipedrive-version-"));
  const valid = join(directory, "package.json");
  writeFileSync(valid, JSON.stringify({ version: "2.0.0-test" }));
  assert.equal(getPackageVersion(valid), "2.0.0-test");
  assert.equal(getPackageVersion(join(directory, "missing.json")), "unknown");
});
