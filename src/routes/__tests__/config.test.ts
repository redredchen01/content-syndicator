import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { app } from '../../server';
import { _setEnvPath } from '../config';

// ── GET /api/settings ─────────────────────────────────────────────────────────

describe('GET /api/settings', () => {
  it('returns 200 with expected shape', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('GEMINI_API_KEY');
    expect(res.body).toHaveProperty('ENABLE_BROWSER_AUTOMATION');
    expect(res.body).toHaveProperty('AUTH_STATUS');
  });

  it('masks sensitive keys (last 4 chars visible)', async () => {
    process.env.GEMINI_API_KEY = 'test-key-1234';
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.GEMINI_API_KEY).not.toBe('test-key-1234');
    expect(res.body.GEMINI_API_KEY).toMatch(/1234$/);
    delete process.env.GEMINI_API_KEY;
  });
});

// ── POST /api/settings — concurrent write safety ──────────────────────────────

describe('POST /api/settings — concurrent write safety', () => {
  let tmpDir: string;
  let tmpEnv: string;
  const originalEnvPath = path.join(process.cwd(), '.env');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    tmpEnv = path.join(tmpDir, '.env');
    _setEnvPath(tmpEnv);
  });

  afterEach(() => {
    _setEnvPath(originalEnvPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('all concurrent POSTs return 200', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app)
          .post('/api/settings')
          .send({ GOOGLE_SHEET_ID: `sheet-${i}` })
          .set('Content-Type', 'application/json'),
      ),
    );

    expect(results.every(r => r.status === 200)).toBe(true);
  });

  it('uses atomic write: no .tmp file left behind after all POSTs complete', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(app)
          .post('/api/settings')
          .send({ GOOGLE_SHEET_ID: `sheet-${i}` })
          .set('Content-Type', 'application/json'),
      ),
    );

    expect(fs.existsSync(tmpEnv + '.tmp')).toBe(false);
    expect(fs.existsSync(tmpEnv)).toBe(true);
  });

  it('no duplicate keys after concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post('/api/settings')
          .send({ GOOGLE_SHEET_ID: `sheet-${i}` })
          .set('Content-Type', 'application/json'),
      ),
    );

    const content = fs.readFileSync(tmpEnv, 'utf8');
    const keys = content
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => l.split('=')[0]);

    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it('every line in .env is a valid KEY=value pair', async () => {
    await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        request(app)
          .post('/api/settings')
          .send({ GOOGLE_SHEET_ID: `sheet-${i}`, SELECTED_MODEL: `gemini-${i}` })
          .set('Content-Type', 'application/json'),
      ),
    );

    const content = fs.readFileSync(tmpEnv, 'utf8');
    const nonEmpty = content.split('\n').filter(l => l.trim());
    for (const line of nonEmpty) {
      expect(line).toMatch(/^[A-Z_]+=.+$/);
    }
  });
});

// ── GET /api/models ───────────────────────────────────────────────────────────

describe('GET /api/models', () => {
  it('returns 200 with models array and selected field', async () => {
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('models');
    expect(res.body).toHaveProperty('selected');
    expect(Array.isArray(res.body.models)).toBe(true);
  });
});
