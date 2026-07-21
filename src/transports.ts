import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import jwt from "jsonwebtoken";
import type { AppConfig } from "./config.js";

export type ServerFactory = () => McpServer;

interface Session<T> {
  server: McpServer;
  transport: T;
  lastActivityAt: number;
}

export interface RunningServer {
  port: number;
  activeSessionCount(): number;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function requestHostname(req: IncomingMessage): string | undefined {
  const header = req.headers.host;
  if (!header || /[@\\/#?,\s]/.test(header)) return undefined;
  try {
    return new URL(`http://${header}`).hostname;
  } catch {
    return undefined;
  }
}

function validateHost(req: IncomingMessage, config: AppConfig): boolean {
  const hostname = requestHostname(req);
  return Boolean(hostname && config.allowedHosts.includes(hostname));
}

function applyCors(req: IncomingMessage, res: ServerResponse, config: AppConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!config.allowedOrigins.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");
  return true;
}

function authenticate(req: IncomingMessage, config: AppConfig): boolean {
  if (!config.jwt) return true;
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return false;
  try {
    jwt.verify(token, config.jwt.secret, {
      algorithms: ["HS256"],
      audience: config.jwt.audience,
      issuer: config.jwt.issuer
    });
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(req: IncomingMessage, maximumBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startStdioServer(createServer: ServerFactory): Promise<RunningServer> {
  const server = createServer();
  const transport = new StdioServerTransport();
  let active = true;
  await server.connect(transport);
  return {
    port: 0,
    activeSessionCount: () => active ? 1 : 0,
    close: async () => {
      if (!active) return;
      active = false;
      await server.close();
    }
  };
}

export async function startHttpServer(config: AppConfig, createServer: ServerFactory): Promise<RunningServer> {
  const streamableSessions = new Map<string, Session<StreamableHTTPServerTransport>>();
  const legacySessions = new Map<string, Session<SSEServerTransport>>();
  let pendingModernSessions = 0;

  const closeExpiredSessions = async (): Promise<void> => {
    const cutoff = Date.now() - config.httpSessions.idleTimeoutMs;
    const expired = [
      ...[...streamableSessions.entries()].filter(([, session]) => session.lastActivityAt < cutoff),
      ...[...legacySessions.entries()].filter(([, session]) => session.lastActivityAt < cutoff)
    ];
    for (const [sessionId] of expired) {
      streamableSessions.delete(sessionId);
      legacySessions.delete(sessionId);
    }
    await Promise.allSettled(expired.map(([, session]) => session.server.close()));
  };

  const atSessionCapacity = (): boolean =>
    streamableSessions.size + legacySessions.size + pendingModernSessions >= config.httpSessions.maximum;

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!validateHost(req, config)) {
        json(res, 403, { error: "Host is not allowed" });
        return;
      }
      if (!applyCors(req, res, config)) {
        json(res, 403, { error: "Origin is not allowed" });
        return;
      }
      await closeExpiredSessions();
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { status: "ok", transport: "http" });
        return;
      }

      const isModernRoute = url.pathname === config.httpPath;
      const isLegacyRoute = config.legacySseEnabled && (url.pathname === "/sse" || url.pathname === "/messages");
      if (!isModernRoute && !isLegacyRoute) {
        json(res, 404, { error: "Not found" });
        return;
      }
      if (!authenticate(req, config)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }

      if (isModernRoute) {
        const sessionId = typeof req.headers["mcp-session-id"] === "string"
          ? req.headers["mcp-session-id"]
          : undefined;
        let session = sessionId ? streamableSessions.get(sessionId) : undefined;
        let parsedBody: unknown;
        let provisionalSession: Session<StreamableHTTPServerTransport> | undefined;
        let capacityReserved = false;

        if (req.method === "POST") parsedBody = await readJsonBody(req);

        if (!session && req.method === "POST" && isInitializeRequest(parsedBody)) {
          if (atSessionCapacity()) {
            json(res, 503, { error: "Session capacity reached" });
            return;
          }
          pendingModernSessions += 1;
          capacityReserved = true;
          let server: McpServer | undefined;
          try {
            server = createServer();
            let transport!: StreamableHTTPServerTransport;
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: randomUUID,
              onsessioninitialized: initializedId => {
                streamableSessions.set(initializedId, { server: server!, transport, lastActivityAt: Date.now() });
              },
              onsessionclosed: closedId => {
                streamableSessions.delete(closedId);
              }
            });
            transport.onclose = () => {
              const closedId = transport.sessionId;
              if (closedId) streamableSessions.delete(closedId);
            };
            await server.connect(transport);
            session = { server, transport, lastActivityAt: Date.now() };
            provisionalSession = session;
          } catch (error) {
            pendingModernSessions -= 1;
            capacityReserved = false;
            await server?.close().catch(() => undefined);
            throw error;
          }
        }

        if (!session) {
          json(res, sessionId ? 404 : 400, { error: sessionId ? "Session not found" : "A valid initialization request is required" });
          return;
        }
        session.lastActivityAt = Date.now();
        try {
          await session.transport.handleRequest(req, res, parsedBody);
        } finally {
          if (provisionalSession) {
            if (capacityReserved) pendingModernSessions -= 1;
            if (!provisionalSession.transport.sessionId) {
              await provisionalSession.server.close();
            }
          }
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/sse") {
        if (atSessionCapacity()) {
          json(res, 503, { error: "Session capacity reached" });
          return;
        }
        const server = createServer();
        // Host and Origin were already validated above. The legacy SDK validator
        // compares the raw Host header (including its port) and is incompatible
        // with the hostname-only allowlist used by the modern route.
        const transport = new SSEServerTransport("/messages", res);
        legacySessions.set(transport.sessionId, { server, transport, lastActivityAt: Date.now() });
        transport.onclose = () => {
          legacySessions.delete(transport.sessionId);
        };
        try {
          await server.connect(transport);
        } catch (error) {
          legacySessions.delete(transport.sessionId);
          await server.close().catch(() => undefined);
          throw error;
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId");
        const session = sessionId ? legacySessions.get(sessionId) : undefined;
        if (!session) {
          json(res, 404, { error: "Session not found" });
          return;
        }
        session.lastActivityAt = Date.now();
        const parsedBody = await readJsonBody(req);
        await session.transport.handlePostMessage(req, res, parsedBody);
        return;
      }

      json(res, 405, { error: "Method not allowed" });
    } catch (error) {
      const message = error instanceof Error && error.message === "REQUEST_TOO_LARGE"
        ? "Request body is too large"
        : "Invalid request";
      if (!res.headersSent) json(res, message === "Request body is too large" ? 413 : 400, { error: message });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  return {
    port,
    activeSessionCount: () => streamableSessions.size + legacySessions.size + pendingModernSessions,
    close: async () => {
      await Promise.allSettled([
        ...[...streamableSessions.values()].map(session => session.server.close()),
        ...[...legacySessions.values()].map(session => session.server.close())
      ]);
      streamableSessions.clear();
      legacySessions.clear();
      await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
    }
  };
}
