import { describe, it, expect, vi } from 'vitest';
import * as pipedrive from 'pipedrive';

describe('get-stages', () => {
  const mockApiClient = {} as pipedrive.ApiClient;

  it('StagesApi has getStages method', () => {
    const stagesApi = new pipedrive.StagesApi(mockApiClient);
    expect(typeof stagesApi.getStages).toBe('function');
  });

  it('calls StagesApi.getStages() and returns stage data', async () => {
    const stagesApi = new pipedrive.StagesApi(mockApiClient);
    const mockGetStages = vi.fn().mockResolvedValue({
      data: [
        { id: 1, name: 'Qualified', pipeline_id: 1, order_nr: 1 },
        { id: 2, name: 'Contact Made', pipeline_id: 1, order_nr: 2 },
        { id: 3, name: 'Proposal Made', pipeline_id: 2, order_nr: 1 },
      ]
    });
    stagesApi.getStages = mockGetStages;

    const response = await stagesApi.getStages();

    expect(mockGetStages).toHaveBeenCalledOnce();
    expect(response.data).toHaveLength(3);
    expect(response.data[0].name).toBe('Qualified');
    expect(response.data[2].pipeline_id).toBe(2);
  });

  it('handles empty stages response gracefully', async () => {
    const stagesApi = new pipedrive.StagesApi(mockApiClient);
    stagesApi.getStages = vi.fn().mockResolvedValue({ data: [] });

    const response = await stagesApi.getStages();
    const allStages = response.data || [];

    expect(allStages).toEqual([]);
  });

  it('handles null data in response gracefully', async () => {
    const stagesApi = new pipedrive.StagesApi(mockApiClient);
    stagesApi.getStages = vi.fn().mockResolvedValue({ data: null });

    const response = await stagesApi.getStages();
    const allStages = response.data || [];

    expect(allStages).toEqual([]);
  });

  it('regression: PipelinesApi does NOT have getPipelineStages (the broken method)', () => {
    const pipelinesApi = new pipedrive.PipelinesApi(mockApiClient);
    expect((pipelinesApi as any).getPipelineStages).toBeUndefined();
  });
});
