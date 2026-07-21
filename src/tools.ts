import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PipedriveGateway, Page } from "./pipedrive-gateway.js";

export interface ToolDependencies {
  gateway: PipedriveGateway;
}

const paginationShape = {
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).optional()
};

const searchShape = {
  term: z.string().min(2).max(500),
  ...paginationShape
};

function listResult(page: Page, filters: Record<string, unknown> = {}): CallToolResult {
  const payload = {
    items: page.items,
    count: page.items.length,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    truncated: page.truncated,
    ...(page.scanned !== undefined ? { scanned: page.scanned } : {}),
    filters
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function itemResult(item: Record<string, unknown>): CallToolResult {
  const payload = { item };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function statusFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("response" in error)) return undefined;
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return undefined;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function sanitizedError(error: unknown): CallToolResult {
  const status = statusFromError(error);
  const code = status ? `PIPEDRIVE_HTTP_${status}` : "PIPEDRIVE_REQUEST_FAILED";
  const retryable = status !== undefined && [429, 502, 503, 504].includes(status);
  const payload = {
    code,
    message: retryable ? "Pipedrive is temporarily unavailable; retry the request." : "The Pipedrive request failed.",
    retryable
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true
  };
}

async function safeCall(operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return sanitizedError(error);
  }
}

export function registerTools(server: McpServer, dependencies: ToolDependencies): void {
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool("get-users", {
    description: "List Pipedrive users/owners.", inputSchema: {}, annotations: readAnnotations
  }, () => safeCall(async () => listResult(await dependencies.gateway.getUsers())));

  server.registerTool("get-deals", {
    description: "List visible, non-archived Pipedrive deals without hidden status or date defaults.",
    inputSchema: {
      ownerId: z.number().int().positive().optional(),
      stageId: z.number().int().positive().optional(),
      pipelineId: z.number().int().positive().optional(),
      status: z.enum(["open", "won", "lost", "deleted"]).optional(),
      updatedSince: z.string().datetime().optional(),
      updatedUntil: z.string().datetime().optional(),
      minValue: z.number().nonnegative().optional(),
      maxValue: z.number().nonnegative().optional(),
      customFieldKeys: z.array(z.string().regex(/^[a-f0-9]{40}$/)).max(15).optional(),
      scanLimit: z.number().int().min(1).max(2000).default(2000),
      ...paginationShape
    },
    annotations: readAnnotations
  }, args => safeCall(async () => {
    const page = await dependencies.gateway.getDeals(args);
    const { cursor: _cursor, ...filters } = args;
    return listResult(page, filters);
  }));

  server.registerTool("get-deal", {
    description: "Get a Pipedrive deal by ID, including generic custom fields.",
    inputSchema: { dealId: z.number().int().positive() }, annotations: readAnnotations
  }, ({ dealId }) => safeCall(async () => itemResult(await dependencies.gateway.getDeal(dealId))));

  server.registerTool("get-deal-notes", {
    description: "List notes attached to a Pipedrive deal.",
    inputSchema: { dealId: z.number().int().positive(), ...paginationShape }, annotations: readAnnotations
  }, ({ dealId, limit, cursor }) => safeCall(async () => listResult(
    await dependencies.gateway.getDealNotes(dealId, limit, cursor), { dealId }
  )));

  server.registerTool("search-deals", {
    description: "Search Pipedrive deals by title, notes, or searchable custom fields.",
    inputSchema: searchShape, annotations: readAnnotations
  }, args => safeCall(async () => listResult(await dependencies.gateway.searchDeals(args), { term: args.term })));

  server.registerTool("get-persons", {
    description: "List Pipedrive persons.", inputSchema: paginationShape, annotations: readAnnotations
  }, ({ limit, cursor }) => safeCall(async () => listResult(await dependencies.gateway.getPersons(limit, cursor))));

  server.registerTool("get-person", {
    description: "Get a Pipedrive person by ID.",
    inputSchema: { personId: z.number().int().positive() }, annotations: readAnnotations
  }, ({ personId }) => safeCall(async () => itemResult(await dependencies.gateway.getPerson(personId))));

  server.registerTool("search-persons", {
    description: "Search Pipedrive persons.", inputSchema: searchShape, annotations: readAnnotations
  }, args => safeCall(async () => listResult(await dependencies.gateway.searchPersons(args), { term: args.term })));

  server.registerTool("get-organizations", {
    description: "List Pipedrive organizations.", inputSchema: paginationShape, annotations: readAnnotations
  }, ({ limit, cursor }) => safeCall(async () => listResult(await dependencies.gateway.getOrganizations(limit, cursor))));

  server.registerTool("get-organization", {
    description: "Get a Pipedrive organization by ID.",
    inputSchema: { organizationId: z.number().int().positive() }, annotations: readAnnotations
  }, ({ organizationId }) => safeCall(async () => itemResult(await dependencies.gateway.getOrganization(organizationId))));

  server.registerTool("search-organizations", {
    description: "Search Pipedrive organizations.", inputSchema: searchShape, annotations: readAnnotations
  }, args => safeCall(async () => listResult(await dependencies.gateway.searchOrganizations(args), { term: args.term })));

  server.registerTool("get-pipelines", {
    description: "List Pipedrive pipelines.", inputSchema: paginationShape, annotations: readAnnotations
  }, ({ limit, cursor }) => safeCall(async () => listResult(await dependencies.gateway.getPipelines(limit, cursor))));

  server.registerTool("get-pipeline", {
    description: "Get a Pipedrive pipeline by ID.",
    inputSchema: { pipelineId: z.number().int().positive() }, annotations: readAnnotations
  }, ({ pipelineId }) => safeCall(async () => itemResult(await dependencies.gateway.getPipeline(pipelineId))));

  server.registerTool("get-stages", {
    description: "List Pipedrive stages, optionally filtered by pipeline.",
    inputSchema: { pipelineId: z.number().int().positive().optional(), ...paginationShape }, annotations: readAnnotations
  }, ({ pipelineId, limit, cursor }) => safeCall(async () => listResult(
    await dependencies.gateway.getStages(limit, cursor, pipelineId), { ...(pipelineId ? { pipelineId } : {}) }
  )));

  server.registerTool("search-leads", {
    description: "Search Pipedrive leads.", inputSchema: searchShape, annotations: readAnnotations
  }, args => safeCall(async () => listResult(await dependencies.gateway.searchLeads(args), { term: args.term })));

  server.registerTool("search-all", {
    description: "Search across supported Pipedrive item types.",
    inputSchema: {
      ...searchShape,
      itemTypes: z.enum(["deal", "person", "organization", "product", "lead", "file", "mail_attachment", "project"]).optional()
    },
    annotations: readAnnotations
  }, args => safeCall(async () => listResult(await dependencies.gateway.searchAll(args), {
    term: args.term, ...(args.itemTypes ? { itemTypes: args.itemTypes } : {})
  })));

}
