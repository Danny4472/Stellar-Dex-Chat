import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { clearIdempotencyStore } from '@/lib/payout/idempotency';

const mockSchema = z.object({
  source: z.string().min(1),
  reason: z.string().min(1),
  amount: z.string().min(1),
  recipient: z.string().min(1),
  reference: z.string().optional(),
});

vi.mock('@/lib/telemetry', () => ({
  telemetry: {
    extractTraceFromHeaders: () => ({ traceId: 'trace', spanId: 'parent' }),
    createSpan: () => ({ spanId: 'span' }),
    addLog: vi.fn(),
    finishSpan: vi.fn(),
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({
  applyRateLimit: vi.fn(() => null),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

const mockTransitionPayoutStatus = vi.fn();
vi.mock('@/lib/transferStore', () => ({
  setTransferStatus: vi.fn(),
  transitionPayoutStatus: (params: unknown) => mockTransitionPayoutStatus(params),
  getTransferStatus: vi.fn(),
}));

const mockInitiateTransfer = vi.fn().mockResolvedValue({ reference: 'ref-123' });
vi.mock('@/lib/payout/providers/registry', () => ({
  getPayoutProvider: () => ({
    initiateTransfer: mockInitiateTransfer,
  }),
}));

vi.mock('@/lib/apiSchemas', () => ({
  initiateTransferSchema: mockSchema,
}));

const { POST } = await import('./route');

function makeRequest(
  body: unknown,
  headersObj: Record<string, string> = { 'x-idempotency-key': 'default-key' },
) {
  return new NextRequest(
    new Request('http://localhost/api/initiate-transfer', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headersObj },
    }),
  );
}

describe('POST /api/initiate-transfer (Issue #32)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearIdempotencyStore();
  });

  it('returns 400 when X-Idempotency-Key header is missing', async () => {
    const req = makeRequest(
      { source: 'wallet', reason: 'payout', amount: '100', recipient: 'G123' },
      {}, // no idempotency header
    );
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.message).toContain('X-Idempotency-Key');
  });

  it('returns 400 for malformed JSON body', async () => {
    const badReq = new NextRequest(
      new Request('http://localhost/api/initiate-transfer', {
        method: 'POST',
        body: 'not json{{{',
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': 'bad-json-key',
        },
      }),
    );

    const res = await POST(badReq);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.message).toContain('Invalid JSON');
  });

  it('returns 400 for validation failures', async () => {
    const req = makeRequest({ source: '', reason: '', amount: '', recipient: '' });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('returns 200 for valid request and records pending transition', async () => {
    const req = makeRequest({
      source: 'wallet',
      reason: 'payment',
      amount: '100',
      recipient: 'GABC123',
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockInitiateTransfer).toHaveBeenCalledTimes(1);
    expect(mockTransitionPayoutStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        targetStatus: 'pending',
        actor: 'user',
        amount: 100,
      }),
    );
  });

  it('returns identical result on retry without calling provider twice', async () => {
    const payload = {
      source: 'wallet',
      reason: 'payment',
      amount: '100',
      recipient: 'GABC123',
    };

    const req1 = makeRequest(payload, { 'x-idempotency-key': 'retry-key' });
    const res1 = await POST(req1);
    const body1 = await res1.json();
    expect(res1.status).toBe(200);

    const req2 = makeRequest(payload, { 'x-idempotency-key': 'retry-key' });
    const res2 = await POST(req2);
    const body2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(body2).toEqual(body1);

    // Provider only called once
    expect(mockInitiateTransfer).toHaveBeenCalledTimes(1);
  });

  it('rejects idempotency key reuse with different payload', async () => {
    const payload1 = {
      source: 'wallet',
      reason: 'payment',
      amount: '100',
      recipient: 'GABC123',
    };

    const req1 = makeRequest(payload1, { 'x-idempotency-key': 'reused-key' });
    const res1 = await POST(req1);
    expect(res1.status).toBe(200);

    const payload2 = {
      source: 'wallet',
      reason: 'payment',
      amount: '9999', // Different amount
      recipient: 'GABC123',
    };

    const req2 = makeRequest(payload2, { 'x-idempotency-key': 'reused-key' });
    const res2 = await POST(req2);
    const body2 = await res2.json();

    expect(res2.status).toBe(422);
    expect(body2.success).toBe(false);
    expect(body2.message).toContain('different payload');
  });
});
