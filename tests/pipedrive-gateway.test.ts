import assert from "node:assert/strict";
import test from "node:test";
import { collectDealPages, requestWithRetry, SdkPipedriveGateway } from "../src/pipedrive-gateway.js";

test("deal pagination scans within the cap without skipping a partial page", async () => {
  const requested: Array<{ limit: number; cursor?: string }> = [];
  const pages = [
    { items: [{ id: 1, value: 5 }, { id: 2, value: 20 }], nextCursor: "page-2" },
    { items: [{ id: 3, value: 30 }], nextCursor: "page-3" }
  ];

  const result = await collectDealPages({
    minValue: 10,
    limit: 2,
    scanLimit: 3
  }, async (limit, cursor) => {
    requested.push({ limit, cursor });
    return pages[requested.length - 1];
  });

  assert.deepEqual(requested, [
    { limit: 2, cursor: undefined },
    { limit: 1, cursor: "page-2" }
  ]);
  assert.deepEqual(result.items.map(item => item.id), [2, 3]);
  assert.equal(result.scanned, 3);
  assert.equal(result.nextCursor, "page-3");
  assert.equal(result.truncated, true);
});

test("deal pagination reports truncation when the scan cap is reached", async () => {
  const result = await collectDealPages({
    minValue: 100,
    limit: 100,
    scanLimit: 2
  }, async () => ({
    items: [{ id: 1, value: 1 }, { id: 2, value: 2 }],
    nextCursor: "more"
  }));

  assert.deepEqual(result.items, []);
  assert.equal(result.scanned, 2);
  assert.equal(result.nextCursor, "more");
  assert.equal(result.truncated, true);
});

test("retry uses bounded exponential delays only for transient HTTP failures", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await requestWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw { response: { status: 429 }, config: { url: "https://example.test?api_token=secret" } };
    return "ok";
  }, async delay => { delays.push(delay); });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);

  await assert.rejects(
    requestWithRetry(async () => { throw { response: { status: 400 } }; }, async () => undefined),
    error => typeof error === "object" && error !== null
  );
});

test("SDK list and search adapters normalize cursors consistently", async () => {
  const gateway = new SdkPipedriveGateway("token", { minTimeMs: 1, maxConcurrent: 10 });
  const listResponse = { data: [{ id: 1 }], additional_data: { next_cursor: "next" } };
  const searchResponse = { data: { items: [{ item: { id: 1 } }] }, additional_data: { next_cursor: "next" } };
  Object.defineProperties(gateway, {
    persons: { value: { getPersons: async () => listResponse, searchPersons: async () => searchResponse } },
    organizations: { value: { getOrganizations: async () => listResponse, searchOrganization: async () => searchResponse } },
    pipelines: { value: { getPipelines: async () => listResponse } },
    stages: { value: { getStages: async () => listResponse } },
    deals: { value: { searchDeals: async () => searchResponse } },
    leads: { value: { searchLeads: async () => searchResponse } },
    itemSearch: { value: { searchItem: async () => searchResponse } }
  });

  const pages = await Promise.all([
    gateway.getPersons(100),
    gateway.getOrganizations(100),
    gateway.getPipelines(100),
    gateway.getStages(100),
    gateway.searchDeals({ term: "deal", limit: 100 }),
    gateway.searchPersons({ term: "person", limit: 100 }),
    gateway.searchOrganizations({ term: "org", limit: 100 }),
    gateway.searchLeads({ term: "lead", limit: 100 }),
    gateway.searchAll({ term: "all", limit: 100 })
  ]);

  for (const page of pages) {
    assert.equal(page.items.length, 1);
    assert.equal(page.nextCursor, "next");
    assert.equal(page.truncated, true);
  }
});

test("deal filters normalize timestamps to Pipedrive's supported second precision", async () => {
  const gateway = new SdkPipedriveGateway("token", { minTimeMs: 1, maxConcurrent: 10 });
  let request: { updated_since?: string; updated_until?: string } | undefined;
  Object.defineProperty(gateway, "deals", {
    value: {
      getDeals: async (options: { updated_since?: string; updated_until?: string }) => {
        request = options;
        return { data: [] };
      }
    }
  });

  await gateway.getDeals({
    updatedSince: "2026-07-20T12:34:56.123Z",
    updatedUntil: "2026-07-21T01:02:03.999Z",
    limit: 100,
    scanLimit: 2_000
  });

  assert.equal(request?.updated_since, "2026-07-20T12:34:56Z");
  assert.equal(request?.updated_until, "2026-07-21T01:02:03Z");
});

test("non-idempotent note creation is never automatically retried", async () => {
  const delays: number[] = [];
  const gateway = new SdkPipedriveGateway(
    "token",
    { minTimeMs: 1, maxConcurrent: 1 },
    async delay => { delays.push(delay); }
  );
  let attempts = 0;
  Object.defineProperty(gateway, "notes", { value: {
    addNote: async () => {
      attempts += 1;
      throw { response: { status: 503 } };
    }
  } });

  await assert.rejects(gateway.addDealNote(1, "note"));
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});
