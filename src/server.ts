import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PipedriveGateway } from "./pipedrive-gateway.js";
import type { WriteToolName } from "./config.js";
import { getPackageVersion } from "./version.js";
import { registerTools, type AuditLogger } from "./tools.js";

export interface ServerDependencies {
  gateway: PipedriveGateway;
  writeTools?: ReadonlySet<WriteToolName>;
  audit?: AuditLogger;
  version?: string;
}

export function createMcpServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer({
    name: "pipedrive-mcp-server",
    version: dependencies.version ?? getPackageVersion()
  });

  registerTools(server, {
    gateway: dependencies.gateway,
    writeTools: dependencies.writeTools ?? new Set(),
    audit: dependencies.audit
  });

  const prompts = [
    ["list-all-deals", "List Pipedrive deals", "List the deals in Pipedrive, following nextCursor until the requested scope is complete."],
    ["list-all-persons", "List Pipedrive persons", "List the persons in Pipedrive and summarize their contact and organization information."],
    ["list-all-pipelines", "List Pipedrive pipelines", "List all pipelines and their stages."],
    ["analyze-deals", "Analyze deals by stage", "Analyze visible Pipedrive deals by stage and total value."],
    ["analyze-contacts", "Analyze contacts", "Analyze Pipedrive persons grouped by organization."],
    ["analyze-leads", "Analyze leads", "Search Pipedrive leads and group them by status."],
    ["compare-pipelines", "Compare pipelines", "Compare all Pipedrive pipelines and their stages."],
    ["find-high-value-deals", "Find high-value deals", "Identify the highest-value visible Pipedrive deals and their current stages."]
  ] as const;

  for (const [name, description, text] of prompts) {
    server.registerPrompt(name, { description }, () => ({
      messages: [{ role: "user", content: { type: "text", text } }]
    }));
  }

  return server;
}
