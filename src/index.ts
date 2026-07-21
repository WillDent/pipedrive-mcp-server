#!/usr/bin/env node
import * as dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { SdkPipedriveGateway } from "./pipedrive-gateway.js";
import { createMcpServer } from "./server.js";
import { startHttpServer, startStdioServer, type RunningServer } from "./transports.js";

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.legacySseAlias) {
    console.error("MCP_TRANSPORT=sse is deprecated; use MCP_TRANSPORT=http and MCP_ENABLE_LEGACY_SSE=true.");
  }

  const gateway = new SdkPipedriveGateway(config.pipedriveApiToken, config.rateLimit);
  const createServer = () => createMcpServer({ gateway });

  let running: RunningServer;
  if (config.transport === "stdio") {
    running = await startStdioServer(createServer);
    console.error("Pipedrive MCP Server started with stdio transport");
  } else {
    running = await startHttpServer(config, createServer);
    console.error(`Pipedrive MCP Server listening on http://${config.host}:${running.port}${config.httpPath}`);
    if (config.legacySseEnabled) console.error("Legacy SSE compatibility is enabled at /sse");
  }

  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : "Unknown startup failure";
  console.error(`Failed to start Pipedrive MCP Server: ${message}`);
  process.exit(1);
});
