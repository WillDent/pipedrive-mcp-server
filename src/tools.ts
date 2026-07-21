import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PipedriveGateway, Page } from "./pipedrive-gateway.js";
import type { WriteToolName } from "./config.js";

export interface AuditEvent {
  timestamp: string;
  operation: WriteToolName;
  entityId: number;
  outcome: "preview" | "success" | "rejected" | "error";
}

export type AuditLogger = (event: AuditEvent) => void;

export interface ToolDependencies {
  gateway: PipedriveGateway;
  writeTools: ReadonlySet<WriteToolName>;
  audit?: AuditLogger;
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

function sanitizedError(error: unknown, allowRetry = true): CallToolResult {
  const status = statusFromError(error);
  const code = status ? `PIPEDRIVE_HTTP_${status}` : "PIPEDRIVE_REQUEST_FAILED";
  const transient = status !== undefined && [429, 502, 503, 504].includes(status);
  const retryable = allowRetry && transient;
  const payload = {
    code,
    message: transient && !allowRetry
      ? "The note request outcome may be ambiguous; verify the deal before trying again."
      : retryable
        ? "Pipedrive is temporarily unavailable; retry the request."
        : "The Pipedrive request failed.",
    retryable
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true
  };
}

async function safeCall(
  operation: () => Promise<CallToolResult>,
  onError?: () => void,
  allowRetry = true
): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    onError?.();
    return sanitizedError(error, allowRetry);
  }
}

function readNumber(entity: Record<string, unknown>, key: string): number | undefined {
  const value = entity[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function escapeNoteText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\n", "<br>");
}

function audit(dependencies: ToolDependencies, event: Omit<AuditEvent, "timestamp">): void {
  try {
    dependencies.audit?.({ timestamp: new Date().toISOString(), ...event });
  } catch {
    // Audit sinks must never change a completed mutation into a reported failure.
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

  if (dependencies.writeTools.has("move-deal")) {
    server.registerTool("move-deal", {
      description: "Preview or execute a guarded deal stage move.",
      inputSchema: {
        dealId: z.number().int().positive(),
        targetStageId: z.number().int().positive(),
        expectedCurrentStageId: z.number().int().positive(),
        execute: z.boolean().default(false)
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, args => safeCall(async () => {
      const deal = await dependencies.gateway.getDeal(args.dealId);
      const currentStageId = readNumber(deal, "stage_id") ?? readNumber(asNestedEntity(deal.stage), "id");
      if (currentStageId !== args.expectedCurrentStageId) {
        audit(dependencies, { operation: "move-deal", entityId: args.dealId, outcome: "rejected" });
        const payload = {
          code: "STALE_DEAL_STAGE",
          message: "The deal stage changed after the request was prepared.",
          retryable: false,
          expectedCurrentStageId: args.expectedCurrentStageId,
          actualCurrentStageId: currentStageId
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
      }
      if (!args.execute) {
        audit(dependencies, { operation: "move-deal", entityId: args.dealId, outcome: "preview" });
        return itemResult({ operation: "move-deal", execute: false, dealId: args.dealId, currentStageId, targetStageId: args.targetStageId });
      }
      const updated = await dependencies.gateway.moveDeal(args.dealId, args.targetStageId);
      audit(dependencies, { operation: "move-deal", entityId: args.dealId, outcome: "success" });
      return itemResult(updated);
    }, () => audit(dependencies, { operation: "move-deal", entityId: args.dealId, outcome: "error" })));
  }

  if (dependencies.writeTools.has("add-deal-note")) {
    server.registerTool("add-deal-note", {
      description: "Preview or execute adding a plain-text note to a deal.",
      inputSchema: {
        dealId: z.number().int().positive(),
        content: z.string().min(1).max(10_000),
        execute: z.boolean().default(false)
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    }, args => safeCall(async () => {
      if (!args.execute) {
        audit(dependencies, { operation: "add-deal-note", entityId: args.dealId, outcome: "preview" });
        return itemResult({ operation: "add-deal-note", execute: false, dealId: args.dealId, contentLength: args.content.length });
      }
      const note = await dependencies.gateway.addDealNote(args.dealId, escapeNoteText(args.content));
      audit(dependencies, { operation: "add-deal-note", entityId: args.dealId, outcome: "success" });
      return itemResult(note);
    }, () => audit(dependencies, { operation: "add-deal-note", entityId: args.dealId, outcome: "error" }), false));
  }
}

function asNestedEntity(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
