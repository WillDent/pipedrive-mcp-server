import Bottleneck from "bottleneck";
import {
  Configuration as V1Configuration,
  NotesApi,
  UsersApi
} from "pipedrive/v1";
import {
  Configuration as V2Configuration,
  DealsApi,
  ItemSearchApi,
  LeadsApi,
  OrganizationsApi,
  PersonsApi,
  PipelinesApi,
  StagesApi
} from "pipedrive/v2";

export type Entity = Record<string, unknown>;

export interface Page<T = Entity> {
  items: T[];
  nextCursor?: string;
  truncated: boolean;
  scanned?: number;
}

export interface DealFilters {
  ownerId?: number;
  stageId?: number;
  pipelineId?: number;
  status?: "open" | "won" | "lost" | "deleted";
  updatedSince?: string;
  updatedUntil?: string;
  minValue?: number;
  maxValue?: number;
  customFieldKeys?: string[];
  limit: number;
  cursor?: string;
  scanLimit: number;
}

export interface SearchOptions {
  term: string;
  limit: number;
  cursor?: string;
}

export interface PipedriveGateway {
  getUsers(): Promise<Page>;
  getDeals(filters: DealFilters): Promise<Page>;
  getDeal(id: number): Promise<Entity>;
  getDealNotes(dealId: number, limit: number, cursor?: string): Promise<Page>;
  searchDeals(options: SearchOptions): Promise<Page>;
  getPersons(limit: number, cursor?: string): Promise<Page>;
  getPerson(id: number): Promise<Entity>;
  searchPersons(options: SearchOptions): Promise<Page>;
  getOrganizations(limit: number, cursor?: string): Promise<Page>;
  getOrganization(id: number): Promise<Entity>;
  searchOrganizations(options: SearchOptions): Promise<Page>;
  getPipelines(limit: number, cursor?: string): Promise<Page>;
  getPipeline(id: number): Promise<Entity>;
  getStages(limit: number, cursor?: string, pipelineId?: number): Promise<Page>;
  searchLeads(options: SearchOptions): Promise<Page>;
  searchAll(options: SearchOptions & { itemTypes?: string }): Promise<Page>;
}

type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function asEntity(value: unknown): Entity {
  return typeof value === "object" && value !== null ? value as Entity : { value };
}

function entities(value: unknown): Entity[] {
  return Array.isArray(value) ? value.map(asEntity) : [];
}

function nextCursor(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const additional = (response as { additional_data?: unknown }).additional_data;
  if (typeof additional !== "object" || additional === null) return undefined;
  const cursor = (additional as { next_cursor?: unknown }).next_cursor;
  return typeof cursor === "string" && cursor ? cursor : undefined;
}

function nestedItems(response: unknown): Entity[] {
  if (typeof response !== "object" || response === null) return [];
  const data = (response as { data?: unknown }).data;
  if (Array.isArray(data)) return entities(data);
  if (typeof data === "object" && data !== null) {
    return entities((data as { items?: unknown }).items);
  }
  return [];
}

function responseData(response: unknown): Entity {
  if (typeof response !== "object" || response === null) return asEntity(response);
  return asEntity((response as { data?: unknown }).data);
}

function pipedriveTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("response" in error)) return undefined;
  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return undefined;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export async function requestWithRetry<T>(
  operation: () => Promise<T>,
  sleep: Sleep = defaultSleep,
  maximumRetries = 2
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const status = errorStatus(error);
      if (attempt >= maximumRetries || !status || ![429, 502, 503, 504].includes(status)) throw error;
      attempt += 1;
      await sleep(250 * 2 ** attempt);
    }
  }
}

interface DealSourcePage {
  items: Entity[];
  nextCursor?: string;
}

export async function collectDealPages(
  filters: DealFilters,
  fetchPage: (limit: number, cursor?: string) => Promise<DealSourcePage>
): Promise<Page> {
  const matches: Entity[] = [];
  let cursor = filters.cursor;
  let scanned = 0;

  while (matches.length < filters.limit && scanned < filters.scanLimit) {
    const pageSize = Math.min(
      500,
      filters.scanLimit - scanned,
      filters.limit - matches.length
    );
    const page = await fetchPage(pageSize, cursor);
    scanned += page.items.length;
    for (const deal of page.items) {
      const rawValue = deal.value;
      const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (filters.minValue !== undefined && (!Number.isFinite(value) || value < filters.minValue)) continue;
      if (filters.maxValue !== undefined && (!Number.isFinite(value) || value > filters.maxValue)) continue;
      matches.push(deal);
    }
    cursor = page.nextCursor;
    if (!cursor || page.items.length === 0) break;
  }

  return {
    items: matches,
    nextCursor: cursor,
    truncated: Boolean(cursor),
    scanned
  };
}

export class SdkPipedriveGateway implements PipedriveGateway {
  private readonly deals: DealsApi;
  private readonly persons: PersonsApi;
  private readonly organizations: OrganizationsApi;
  private readonly pipelines: PipelinesApi;
  private readonly stages: StagesApi;
  private readonly itemSearch: ItemSearchApi;
  private readonly leads: LeadsApi;
  private readonly notes: NotesApi;
  private readonly users: UsersApi;
  private readonly limiter: Bottleneck;

  constructor(apiToken: string, rateLimit: { minTimeMs: number; maxConcurrent: number }, private readonly sleep: Sleep = defaultSleep) {
    const v2 = new V2Configuration({ apiKey: apiToken });
    const v1 = new V1Configuration({ apiKey: apiToken });
    this.deals = new DealsApi(v2);
    this.persons = new PersonsApi(v2);
    this.organizations = new OrganizationsApi(v2);
    this.pipelines = new PipelinesApi(v2);
    this.stages = new StagesApi(v2);
    this.itemSearch = new ItemSearchApi(v2);
    this.leads = new LeadsApi(v2);
    this.notes = new NotesApi(v1);
    this.users = new UsersApi(v1);
    this.limiter = new Bottleneck({ minTime: rateLimit.minTimeMs, maxConcurrent: rateLimit.maxConcurrent });
  }

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    return requestWithRetry(() => this.limiter.schedule(operation), this.sleep);
  }

  async getUsers(): Promise<Page> {
    const response = await this.request(() => this.users.getUsers());
    return { items: entities(response.data), truncated: false };
  }

  async getDeals(filters: DealFilters): Promise<Page> {
    return collectDealPages(filters, async (limit, cursor) => {
      const response = await this.request(() => this.deals.getDeals({
        owner_id: filters.ownerId,
        stage_id: filters.stageId,
        pipeline_id: filters.pipelineId,
        status: filters.status,
        updated_since: pipedriveTimestamp(filters.updatedSince),
        updated_until: pipedriveTimestamp(filters.updatedUntil),
        custom_fields: filters.customFieldKeys?.join(","),
        limit,
        cursor
      }));
      return { items: entities(response.data), nextCursor: nextCursor(response) };
    });
  }

  async getDeal(id: number): Promise<Entity> {
    return responseData(await this.request(() => this.deals.getDeal({ id })));
  }

  async getDealNotes(dealId: number, limit: number, cursor?: string): Promise<Page> {
    const start = cursor === undefined ? undefined : Number(cursor);
    const response = await this.request(() => this.notes.getNotes({ deal_id: dealId, limit, start }));
    const pagination = response.additional_data?.pagination;
    return {
      items: entities(response.data),
      nextCursor: pagination?.more_items_in_collection && pagination.next_start !== undefined
        ? String(pagination.next_start)
        : undefined,
      truncated: Boolean(pagination?.more_items_in_collection)
    };
  }

  async searchDeals(options: SearchOptions): Promise<Page> {
    const response = await this.request(() => this.deals.searchDeals({
      term: options.term, limit: options.limit, cursor: options.cursor
    }));
    const items = nestedItems(response);
    const cursor = nextCursor(response);
    return { items, nextCursor: cursor, truncated: Boolean(cursor) };
  }

  async getPersons(limit: number, cursor?: string): Promise<Page> {
    const response = await this.request(() => this.persons.getPersons({ limit, cursor }));
    const next = nextCursor(response);
    return { items: entities(response.data), nextCursor: next, truncated: Boolean(next) };
  }

  async getPerson(id: number): Promise<Entity> {
    return responseData(await this.request(() => this.persons.getPerson({ id })));
  }

  async searchPersons(options: SearchOptions): Promise<Page> {
    const response = await this.request(() => this.persons.searchPersons({ term: options.term, limit: options.limit, cursor: options.cursor }));
    const cursor = nextCursor(response);
    return { items: nestedItems(response), nextCursor: cursor, truncated: Boolean(cursor) };
  }

  async getOrganizations(limit: number, cursor?: string): Promise<Page> {
    const response = await this.request(() => this.organizations.getOrganizations({ limit, cursor }));
    const next = nextCursor(response);
    return { items: entities(response.data), nextCursor: next, truncated: Boolean(next) };
  }

  async getOrganization(id: number): Promise<Entity> {
    return responseData(await this.request(() => this.organizations.getOrganization({ id })));
  }

  async searchOrganizations(options: SearchOptions): Promise<Page> {
    const response = await this.request(() => this.organizations.searchOrganization({ term: options.term, limit: options.limit, cursor: options.cursor }));
    const cursor = nextCursor(response);
    return { items: nestedItems(response), nextCursor: cursor, truncated: Boolean(cursor) };
  }

  async getPipelines(limit: number, cursor?: string): Promise<Page> {
    const response = await this.request(() => this.pipelines.getPipelines({ limit, cursor }));
    const next = nextCursor(response);
    return { items: entities(response.data), nextCursor: next, truncated: Boolean(next) };
  }

  async getPipeline(id: number): Promise<Entity> {
    return responseData(await this.request(() => this.pipelines.getPipeline({ id })));
  }

  async getStages(limit: number, cursor?: string, pipelineId?: number): Promise<Page> {
    const response = await this.request(() => this.stages.getStages({ limit, cursor, pipeline_id: pipelineId }));
    const next = nextCursor(response);
    return { items: entities(response.data), nextCursor: next, truncated: Boolean(next) };
  }

  async searchLeads(options: SearchOptions): Promise<Page> {
    const response = await this.request(() => this.leads.searchLeads({ term: options.term, limit: options.limit, cursor: options.cursor }));
    const cursor = nextCursor(response);
    return { items: nestedItems(response), nextCursor: cursor, truncated: Boolean(cursor) };
  }

  async searchAll(options: SearchOptions & { itemTypes?: string }): Promise<Page> {
    const response = await this.request(() => this.itemSearch.searchItem({
      term: options.term,
      item_types: options.itemTypes as "deal" | "person" | "organization" | "product" | "lead" | "file" | "mail_attachment" | "project" | undefined,
      limit: Math.min(options.limit, 100),
      cursor: options.cursor
    }));
    const cursor = nextCursor(response);
    return { items: nestedItems(response), nextCursor: cursor, truncated: Boolean(cursor) };
  }

}
