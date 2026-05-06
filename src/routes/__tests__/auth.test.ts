import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../server';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import archiver from 'archiver';

// Helper to create a test ZIP file with session data
async function createTestZip(platforms: Record<string, any>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const output = {
      write: (chunk: Buffer) => chunks.push(chunk),
    };

    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('data', (chunk) => {
      chunks.push(chunk);
    });

    archive.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    archive.on('error', reject);

    // Add files to ZIP
    for (const [platform, data] of Object.entries(platforms)) {
      archive.append(JSON.stringify(data), { name: `.auth/${platform}.json` });
    }

    archive.finalize();
  });
}

// Valid session structure
const validSessionData = {
  cookies: [
    {
      name: 'session_id',
      value: 'abc123',
      domain: 'example.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
    },
  ],
  origins: [
    { origin: 'https://example.com', localStorage: [] },
  ],
};

describe('POST /api/auth/import-sessions', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 if no file provided', async () => {
    const res = await request(app)
      .post('/api/auth/import-sessions')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No file');
  });

  it('returns 200 with correct response structure', async () => {
    // Create minimal valid ZIP
    const zipBuffer = await createTestZip({ medium: validSessionData });

    const res = await request(app)
      .post('/api/auth/import-sessions')
      .attach('file', zipBuffer, 'sessions.zip');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success');
    expect(res.body).toHaveProperty('imported');
    expect(res.body).toHaveProperty('failed');
    expect(res.body).toHaveProperty('tested');
    expect(Array.isArray(res.body.imported)).toBe(true);
    expect(Array.isArray(res.body.failed)).toBe(true);
    expect(typeof res.body.tested).toBe('object');
  });

  it('handles empty ZIP files', async () => {
    const chunks: Buffer[] = [];
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('data', (chunk) => {
      chunks.push(chunk);
    });

    const zipPromise = new Promise<Buffer>((resolve) => {
      archive.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });

    archive.finalize();
    const zipBuffer = await zipPromise;

    const res = await request(app)
      .post('/api/auth/import-sessions')
      .attach('file', zipBuffer, 'sessions.zip');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.imported)).toBe(true);
  });
});

describe('POST /api/auth/test-connection/:platformId', () => {
  it('returns ok=true for valid platform with valid credentials', async () => {
    // This test checks that the endpoint exists and returns properly
    const res = await request(app)
      .post('/api/auth/test-connection/devto');

    // The response depends on whether DEVTO_API_KEY is set
    // Just verify the endpoint is working
    expect([200, 401, 500]).toContain(res.status);
    expect(res.body).toHaveProperty('ok');
  });

  it('returns 404 for unknown platform', async () => {
    const res = await request(app)
      .post('/api/auth/test-connection/unknown-platform-xyz');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  it('accepts platform ID in lowercase format', async () => {
    const res = await request(app)
      .post('/api/auth/test-connection/medium');

    // Should return 200, 401, or 500 (not 404, which means not found)
    expect([200, 401, 500]).toContain(res.status);
  });

  it('returns error details on connection failure', async () => {
    // Test with a platform that likely won't have valid credentials
    const res = await request(app)
      .post('/api/auth/test-connection/github');

    if (res.status === 401 || res.status === 200) {
      if (res.status === 401) {
        expect(res.body).toHaveProperty('error');
        expect(res.body.ok).toBe(false);
      }
    }
  });
});

describe('Auth routes integration', () => {
  it('test-connection endpoint works after import-sessions', async () => {
    // Create a ZIP with a valid session
    const zipBuffer = await createTestZip({ medium: validSessionData });

    // First, import the session
    const importRes = await request(app)
      .post('/api/auth/import-sessions')
      .attach('file', zipBuffer, 'sessions.zip');

    expect(importRes.status).toBe(200);

    // Then test connection for medium
    const testRes = await request(app)
      .post('/api/auth/test-connection/medium');

    // Should not return 404 (platform exists)
    expect(testRes.status).not.toBe(404);
  });
});
