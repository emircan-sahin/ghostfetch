import { describe, it, expect, afterAll } from 'vitest';
import { GhostFetch } from '../src';

describe('GhostFetch — basic request', () => {
  const client = new GhostFetch({
    timeout: 15000,
    retry: { maxRetries: 0 },
  });

  afterAll(async () => {
    await client.destroy();
  });

  it('should GET CoinGecko BTC 24h chart data', async () => {
    const res = await client.get('https://www.coingecko.com/price_charts/bitcoin/usd/24_hours.json');

    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();

    const data = JSON.parse(res.body);
    expect(data).toHaveProperty('stats');
    console.log(`CoinGecko responded: status=${res.status}, data points=${data.stats?.length ?? 0}`);
  }, 30000);
});
