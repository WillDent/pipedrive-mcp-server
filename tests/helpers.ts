import type { AppConfig } from "../src/config.js";
import type {
  DealFilters,
  Entity,
  Page,
  PipedriveGateway,
  SearchOptions
} from "../src/pipedrive-gateway.js";

const emptyPage = (): Page => ({ items: [], truncated: false });

export class FakeGateway implements PipedriveGateway {
  deal: Entity = { id: 1, stage_id: 10, title: "Test deal" };
  dealsPage: Page = { items: [this.deal], truncated: false };
  lastDealFilters?: DealFilters;

  async getUsers(): Promise<Page> { return emptyPage(); }
  async getDeals(filters: DealFilters): Promise<Page> { this.lastDealFilters = filters; return this.dealsPage; }
  async getDeal(): Promise<Entity> { return this.deal; }
  async getDealNotes(): Promise<Page> { return emptyPage(); }
  async searchDeals(_options: SearchOptions): Promise<Page> { return emptyPage(); }
  async getPersons(): Promise<Page> { return emptyPage(); }
  async getPerson(): Promise<Entity> { return { id: 2 }; }
  async searchPersons(_options: SearchOptions): Promise<Page> { return emptyPage(); }
  async getOrganizations(): Promise<Page> { return emptyPage(); }
  async getOrganization(): Promise<Entity> { return { id: 3 }; }
  async searchOrganizations(_options: SearchOptions): Promise<Page> { return emptyPage(); }
  async getPipelines(): Promise<Page> { return emptyPage(); }
  async getPipeline(): Promise<Entity> { return { id: 4 }; }
  async getStages(): Promise<Page> { return emptyPage(); }
  async searchLeads(_options: SearchOptions): Promise<Page> { return emptyPage(); }
  async searchAll(_options: SearchOptions & { itemTypes?: string }): Promise<Page> { return emptyPage(); }
}

export function httpConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    pipedriveApiToken: "test-token",
    transport: "http",
    legacySseAlias: false,
    host: "127.0.0.1",
    port: 0,
    httpPath: "/mcp",
    legacySseEnabled: true,
    allowedHosts: ["127.0.0.1", "localhost"],
    allowedOrigins: [],
    rateLimit: { minTimeMs: 1, maxConcurrent: 1 },
    httpSessions: { maximum: 100, idleTimeoutMs: 1_800_000 },
    ...overrides
  };
}
