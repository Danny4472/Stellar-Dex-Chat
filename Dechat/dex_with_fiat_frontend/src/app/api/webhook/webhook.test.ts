/**
 * Unit tests for the Paystack webhook route handler (Issue #33 & #34).
 *
 * Acceptance criteria:
 *  - Missing secret key → 400 before body is read
 *  - Missing, malformed, or invalid HMAC signature → 401
 *  - Raw payload verification via constant-time comparison
 *  - Route-level assertion that rejected events cause no writes to store
 *  - Key rotation with bounded overlap window
 *  - Centralized payout transitions via transitionPayoutStatus
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

vi.mock('server-only', () => ({}));

const mockEnv = {
  PAYSTACK_SECRET_KEY: 'test-secret',
  PAYSTACK_SECRET_KEY_PREVIOUS: 'previous-test-secret',
  PAYOUT_PROVIDER: 'paystack',
} as Record<string, string | undefined>;

process.env.PAYSTACK_SECRET_KEY = 'test-secret';
process.env.PAYSTACK_SECRET_KEY_PREVIOUS = 'previous-test-secret';

vi.mock('@/lib/serverEnv', () => ({
  get serverEnv() {
    return mockEnv;
  },
}));

vi.mock('@/lib/telemetry', () => ({
  telemetry: {
    extractTraceFromHeaders: () => ({ traceId: 'trace1', spanId: 'span1' }),
    createSpan: () => ({ spanId: 'span1' }),
    addLog: vi.fn(),
    finishSpan: vi.fn(),
    setTraceHeaders: vi.fn(),
    generateTraceId: () => 'trace1',
    generateSpanId: () => 'span1',
    logWithTrace: vi.fn(),
  },
}));

const mockTransitionPayoutStatus = vi.fn((params) => ({
  reference: params.reference,
  status: params.targetStatus,
  amount: params.amount ?? 5000,
  clientSessionId: params.clientSessionId ?? 'session1',
}));

vi.mock('@/lib/transferStore', () => ({
  isReplayEvent: vi.fn(() => false),
  replayCacheStats: () => ({ size: 0, ttlMs: 0, maxSize: 0 }),
  getTransferStatus: vi.fn(() => ({ clientSessionId: 'session1', status: 'pending' })),
  setTransferStatus: vi.fn(),
  transitionPayoutStatus: (params: unknown) => mockTransitionPayoutStatus(params),
  InvalidPayoutTransitionError: class InvalidPayoutTransitionError extends Error {},
  transferStore: { set: vi.fn(), get: vi.fn() },
}));

vi.mock('@/lib/paymentStatusEvents', () => ({
  publishPaymentStatus: vi.fn(),
}));

// Import route handler after mocks
const { POST } = await import('@/app/api/webhook/route');

function makeRequest(
  payload: string,
  signature: string | null,
  timestamp?: string | null,
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature !== null) headers.set('x-paystack-signature', signature);
  if (timestamp) headers.set('x-paystack-signature-timestamp', timestamp);
  return new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers,
    body: payload,
  });
}

function hmac(payload: string, secret: string): string {
  return crypto.createHmac('sha512', secret).update(payload).digest('hex');
}

describe('POST /api/webhook', () => {
  const payload = JSON.stringify({
    event: 'transfer.success',
    data: { reference: 'ref123', id: 'id-1', amount: 5000 },
  });

  beforeEach(() => {
    mockEnv['PAYSTACK_SECRET_KEY'] = 'test-secret';
    process.env.PAYSTACK_SECRET_KEY = 'test-secret';
    process.env.PAYSTACK_SECRET_KEY_PREVIOUS = 'previous-test-secret';
    mockTransitionPayoutStatus.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when PAYSTACK_SECRET_KEY is not configured and performs NO writes', async () => {
    mockEnv['PAYSTACK_SECRET_KEY'] = undefined;
    process.env.PAYSTACK_SECRET_KEY = '';
    process.env.PAYSTACK_SECRET_KEY_PREVIOUS = '';
    const req = makeRequest(payload, null);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockTransitionPayoutStatus).not.toHaveBeenCalled();
  });

  it('returns 401 when signature is missing and causes NO writes', async () => {
    const req = makeRequest(payload, null);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockTransitionPayoutStatus).not.toHaveBeenCalled();
  });

  it('returns 401 on malformed signature and causes NO writes', async () => {
    const req = makeRequest(payload, 'not-a-valid-hex-or-length');
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockTransitionPayoutStatus).not.toHaveBeenCalled();
  });

  it('returns 401 on invalid signature and causes NO writes', async () => {
    const invalidSig = 'a'.repeat(128);
    const req = makeRequest(payload, invalidSig);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockTransitionPayoutStatus).not.toHaveBeenCalled();
  });

  it('returns 401 on tampered payload and causes NO writes', async () => {
    const originalSig = hmac(payload, 'test-secret');
    const tamperedPayload = payload.replace('5000', '99999');
    const req = makeRequest(tamperedPayload, originalSig);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockTransitionPayoutStatus).not.toHaveBeenCalled();
  });

  it('returns 200 and records transition for valid signature', async () => {
    const sig = hmac(payload, 'test-secret');
    const req = makeRequest(payload, sig);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockTransitionPayoutStatus).toHaveBeenCalledTimes(1);
    expect(mockTransitionPayoutStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: 'ref123',
        targetStatus: 'success',
        actor: 'webhook',
      }),
    );
  });

  it('supports key rotation: accepts signature signed with previous secret', async () => {
    const rotatedSig = hmac(payload, 'previous-test-secret');
    const req = makeRequest(payload, rotatedSig);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockTransitionPayoutStatus).toHaveBeenCalledTimes(1);
  });
});
