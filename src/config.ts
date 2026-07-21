import { isIP } from "node:net";
import { z } from "zod";

export interface AppConfig {
  pipedriveApiToken: string;
  transport: "stdio" | "http";
  legacySseAlias: boolean;
  host: string;
  port: number;
  httpPath: string;
  legacySseEnabled: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
  jwt?: {
    secret: string;
    audience?: string;
    issuer?: string;
  };
  rateLimit: {
    minTimeMs: number;
    maxConcurrent: number;
  };
  httpSessions: {
    maximum: number;
    idleTimeoutMs: number;
  };
}

const positiveInteger = (name: string, fallback: number) =>
  z.preprocess(
    value => value === undefined || value === "" ? fallback : Number(value),
    z.number({ invalid_type_error: `${name} must be a number` }).int().positive()
  );

const booleanValue = (fallback: boolean) =>
  z.preprocess(value => {
    if (value === undefined || value === "") return fallback;
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) {
      return value.toLowerCase() === "true";
    }
    return value;
  }, z.boolean());

const pathValue = z.string().refine(value => value.startsWith("/") && !value.includes("?") && !value.includes("#"), {
  message: "MCP_HTTP_PATH must be an absolute URL path without a query string or fragment"
});

const optionalString = (schema: z.ZodString) =>
  z.preprocess(value => value === "" ? undefined : value, schema.optional());

const envSchema = z.object({
  PIPEDRIVE_API_TOKEN: z.string({ required_error: "PIPEDRIVE_API_TOKEN is required" }).min(1, "PIPEDRIVE_API_TOKEN is required"),
  MCP_TRANSPORT: z.enum(["stdio", "http", "sse"]).default("stdio"),
  MCP_HOST: z.string().min(1).refine(
    value => isIP(value) > 0 || value === "localhost" || /^[a-z0-9.-]+$/i.test(value),
    "MCP_HOST must be an IP address or hostname without a scheme, path, or port"
  ).default("127.0.0.1"),
  MCP_PORT: positiveInteger("MCP_PORT", 3000).refine(value => value <= 65535, "MCP_PORT must be at most 65535"),
  MCP_HTTP_PATH: pathValue.default("/mcp"),
  MCP_ENABLE_LEGACY_SSE: booleanValue(true),
  MCP_ALLOWED_HOSTS: z.string().optional(),
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  MCP_JWT_SECRET: optionalString(z.string().min(32, "MCP_JWT_SECRET must be at least 32 characters")),
  MCP_JWT_AUDIENCE: optionalString(z.string().min(1)),
  MCP_JWT_ISSUER: optionalString(z.string().min(1)),
  PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS: positiveInteger("PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS", 250),
  PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT: positiveInteger("PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT", 2),
  MCP_MAX_SESSIONS: positiveInteger("MCP_MAX_SESSIONS", 100).refine(value => value <= 10_000, "MCP_MAX_SESSIONS must be at most 10000"),
  MCP_SESSION_IDLE_TIMEOUT_MS: positiveInteger("MCP_SESSION_IDLE_TIMEOUT_MS", 1_800_000)
});

const splitList = (value?: string): string[] =>
  [...new Set((value ?? "").split(",").map(item => item.trim()).filter(Boolean))];

function parseAllowedHosts(value?: string): string[] {
  return splitList(value).map(host => {
    if (host === "*" || host.includes("/") || host.includes("@")) {
      throw new Error(`Invalid MCP_ALLOWED_HOSTS entry: ${host}`);
    }
    if (isIP(host) === 6) return `[${host}]`;
    try {
      const parsed = new URL(`http://${host}`);
      if (parsed.hostname !== host || parsed.port) throw new Error();
      return parsed.hostname;
    } catch {
      throw new Error(`Invalid MCP_ALLOWED_HOSTS entry: ${host}; use hostnames without schemes, paths, or ports`);
    }
  });
}

function parseAllowedOrigins(value?: string): string[] {
  return splitList(value).map(origin => {
    try {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
        throw new Error();
      }
      return origin;
    } catch {
      throw new Error(`Invalid MCP_ALLOWED_ORIGINS entry: ${origin}; use an exact http(s) origin such as https://app.example.com`);
    }
  });
}

const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "::1";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const legacySseAlias = parsed.MCP_TRANSPORT === "sse";
  const transport = parsed.MCP_TRANSPORT === "stdio" ? "stdio" : "http";
  const allowedHosts = parseAllowedHosts(parsed.MCP_ALLOWED_HOSTS);
  const allowedOrigins = parseAllowedOrigins(parsed.MCP_ALLOWED_ORIGINS);

  if (["/health", "/sse", "/messages"].includes(parsed.MCP_HTTP_PATH)) {
    throw new Error("MCP_HTTP_PATH conflicts with a reserved server path");
  }

  if (transport === "http" && isLoopback(parsed.MCP_HOST) && allowedHosts.length === 0) {
    allowedHosts.push("localhost", "127.0.0.1", "[::1]");
  }

  if (transport === "http" && !isLoopback(parsed.MCP_HOST)) {
    if (!parsed.MCP_JWT_SECRET) {
      throw new Error("MCP_JWT_SECRET is required when MCP_HOST is not loopback");
    }
    if (allowedHosts.length === 0) {
      throw new Error("MCP_ALLOWED_HOSTS is required when MCP_HOST is not loopback");
    }
  }

  return {
    pipedriveApiToken: parsed.PIPEDRIVE_API_TOKEN,
    transport,
    legacySseAlias,
    host: parsed.MCP_HOST,
    port: parsed.MCP_PORT,
    httpPath: parsed.MCP_HTTP_PATH,
    legacySseEnabled: legacySseAlias || parsed.MCP_ENABLE_LEGACY_SSE,
    allowedHosts,
    allowedOrigins,
    jwt: parsed.MCP_JWT_SECRET ? {
      secret: parsed.MCP_JWT_SECRET,
      audience: parsed.MCP_JWT_AUDIENCE,
      issuer: parsed.MCP_JWT_ISSUER
    } : undefined,
    rateLimit: {
      minTimeMs: parsed.PIPEDRIVE_RATE_LIMIT_MIN_TIME_MS,
      maxConcurrent: parsed.PIPEDRIVE_RATE_LIMIT_MAX_CONCURRENT
    },
    httpSessions: {
      maximum: parsed.MCP_MAX_SESSIONS,
      idleTimeoutMs: parsed.MCP_SESSION_IDLE_TIMEOUT_MS
    }
  };
}
