import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../server';

describe('GET /health', () => {
  it('returns HTTP 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('includes a positive uptime', async () => {
    const res = await request(app).get('/health');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThan(0);
  });

  it('includes version matching package.json', async () => {
    const { version } = await import('../../package.json');
    const res = await request(app).get('/health');
    expect(res.body.version).toBe(version);
  });
});
