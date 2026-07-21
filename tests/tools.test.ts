import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { escapeNoteText, type AuditEvent } from "../src/tools.js";
import { FakeGateway } from "./helpers.js";

async function connectedClient(gateway: FakeGateway, writes: string[] = [], audit?: (event: AuditEvent) => void) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    gateway,
    version: "test",
    writeTools: new Set(writes as Array<"move-deal" | "add-deal-note">),
    audit
  });
  const client = new Client({ name: "test-client", version: "test" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("read-only is the default and get-deals has no hidden filters", async () => {
  const gateway = new FakeGateway();
  const { client, server } = await connectedClient(gateway);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.some(tool => tool.name === "move-deal"), false);
    assert.equal(tools.tools.some(tool => tool.name === "add-deal-note"), false);

    const result = await client.callTool({ name: "get-deals", arguments: {} });
    assert.deepEqual(gateway.lastDealFilters, {
      scanLimit: 2000,
      limit: 100
    });
    assert.deepEqual(result.structuredContent, {
      items: [gateway.deal],
      count: 1,
      truncated: false,
      filters: { scanLimit: 2000, limit: 100 }
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("move-deal previews, rejects stale state, then executes", async () => {
  const gateway = new FakeGateway();
  const { client, server } = await connectedClient(gateway, ["move-deal"]);
  try {
    const preview = await client.callTool({
      name: "move-deal",
      arguments: { dealId: 1, targetStageId: 20, expectedCurrentStageId: 10 }
    });
    assert.equal(preview.isError, undefined);
    assert.equal(gateway.moveCalls.length, 0);

    const stale = await client.callTool({
      name: "move-deal",
      arguments: { dealId: 1, targetStageId: 20, expectedCurrentStageId: 11, execute: true }
    });
    assert.equal(stale.isError, true);
    assert.equal(gateway.moveCalls.length, 0);

    const executed = await client.callTool({
      name: "move-deal",
      arguments: { dealId: 1, targetStageId: 20, expectedCurrentStageId: 10, execute: true }
    });
    assert.equal(executed.isError, undefined);
    assert.deepEqual(gateway.moveCalls, [{ dealId: 1, targetStageId: 20 }]);

    const duplicate = await client.callTool({
      name: "move-deal",
      arguments: { dealId: 1, targetStageId: 20, expectedCurrentStageId: 10, execute: true }
    });
    assert.equal(duplicate.isError, true);
    assert.deepEqual(gateway.moveCalls, [{ dealId: 1, targetStageId: 20 }]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("write failures are sanitized and audit logs contain metadata only", async () => {
  const gateway = new FakeGateway();
  gateway.addDealNote = async () => {
    throw {
      response: { status: 503 },
      config: { url: "https://api.pipedrive.com/v1/notes?api_token=super-secret" }
    };
  };
  const events: AuditEvent[] = [];
  const { client, server } = await connectedClient(gateway, ["add-deal-note"], event => events.push(event));
  try {
    const result = await client.callTool({
      name: "add-deal-note",
      arguments: { dealId: 1, content: "private note", execute: true }
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      code: "PIPEDRIVE_HTTP_503",
      message: "The note request outcome may be ambiguous; verify the deal before trying again.",
      retryable: false
    });
    assert.deepEqual(events.map(({ operation, entityId, outcome }) => ({ operation, entityId, outcome })), [{
      operation: "add-deal-note", entityId: 1, outcome: "error"
    }]);
    assert.equal(JSON.stringify(events).includes("private note"), false);
    assert.equal(JSON.stringify(result).includes("super-secret"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("audit sink failures do not turn a successful note mutation into a retryable failure", async () => {
  const gateway = new FakeGateway();
  const { client, server } = await connectedClient(gateway, ["add-deal-note"], () => {
    throw new Error("audit sink unavailable");
  });
  try {
    const result = await client.callTool({
      name: "add-deal-note",
      arguments: { dealId: 1, content: "one note", execute: true }
    });
    assert.equal(result.isError, undefined);
    assert.equal(gateway.noteCalls.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("add-deal-note is preview-first and escapes plain text", async () => {
  const gateway = new FakeGateway();
  const { client, server } = await connectedClient(gateway, ["add-deal-note"]);
  try {
    await client.callTool({ name: "add-deal-note", arguments: { dealId: 1, content: "<b>A&B</b>" } });
    assert.equal(gateway.noteCalls.length, 0);
    await client.callTool({
      name: "add-deal-note",
      arguments: { dealId: 1, content: "<b>A&B</b>\nnext", execute: true }
    });
    assert.deepEqual(gateway.noteCalls, [{
      dealId: 1,
      content: "&lt;b&gt;A&amp;B&lt;/b&gt;<br>next"
    }]);
    assert.equal(escapeNoteText('"quoted"'), "&quot;quoted&quot;");
  } finally {
    await client.close();
    await server.close();
  }
});
