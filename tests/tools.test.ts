import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { FakeGateway } from "./helpers.js";

async function connectedClient(gateway: FakeGateway) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ gateway, version: "test" });
  const client = new Client({ name: "test-client", version: "test" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("2.0 is read-only and get-deals has no hidden filters", async () => {
  const gateway = new FakeGateway();
  const { client, server } = await connectedClient(gateway);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.some(tool => tool.annotations?.readOnlyHint === false), false);
    assert.equal(tools.tools.some(tool => tool.name === "move-deal"), false);
    assert.equal(tools.tools.some(tool => tool.name === "add-deal-note"), false);

    const result = await client.callTool({ name: "get-deals", arguments: {} });
    assert.deepEqual(gateway.lastDealFilters, { scanLimit: 2000, limit: 100 });
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
