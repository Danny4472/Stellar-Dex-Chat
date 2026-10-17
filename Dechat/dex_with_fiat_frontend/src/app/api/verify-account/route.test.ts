import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

import { POST } from './route';
import { getSharedRateLimitStore } from '@/lib/rateLimit';
import * as registry from '@/lib/payout/providers/registry';

describe('Route Contract: /api/verify-account', () => {
  const verifyAccountMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getSharedRateLimitStore().reset();
    verifyAccountMock.mockResolvedValue({
      account_number: '0123456789',
      account_name: 'Ada Lovelace',
      bank_id: 58,
    });
    vi.spyOn(registry, 'getPayoutProvider').mockReturnValue({
      name: 'paystack' as const,
      verifyAccount: verifyAccountMock,
      createRecipient: vi.fn(),
      initiateTransfer: vi.fn(),
      checkTransferStatus: vi.fn(),
    });
  });

  function makeRequest(body: unknown, raw = false) {
    return new NextRequest(
      new Request('http://localhost/api/verify-account', {
        method: 'POST',
        body: raw ? (body as string) : JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  it('returns 200 and normalized data for valid request', async () => {
    const req = makeRequest({
      accountNumber: ' 0123456789 ',
      bankCode: ' 058 ',
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.account_name).toBe('Ada Lovelace');
    // Normalization verification before provider call
    expect(verifyAccountMock).toHaveBeenCalledWith({
      accountNumber: '0123456789',
      bankCode: '058',
    });
    expect(res.headers.get('X-Correlation-Id')).toBeDefined();
  });

  it('returns 400 for malformed JSON body', async () => {
    const req = makeRequest('not-json{{{', true);
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.version).toBe('v1');
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('MALFORMED_REQUEST');
    expect(body.error.category).toBe('validation');
  });

  it('returns 400 with field-level errors for invalid account format without revealing account existence', async () => {
    const req = makeRequest({
      accountNumber: '123', // shorter than 10 digits
      bankCode: '058',
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.version).toBe('v1');
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.category).toBe('validation');
    expect(body.error.details).toBeDefined();
    expect(body.error.details.some((d: any) => d.field === 'accountNumber')).toBe(true);
    expect(verifyAccountMock).not.toHaveBeenCalled();
  });

  it('returns 400 when unknown fields are present (strict server-side validation)', async () => {
    const req = makeRequest({
      accountNumber: '0123456789',
      bankCode: '058',
      unknownField: 'exploit',
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.version).toBe('v1');
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(verifyAccountMock).not.toHaveBeenCalled();
  });

  it('returns 400 safe error when provider returns 422', async () => {
    verifyAccountMock.mockRejectedValue({
      response: {
        status: 422,
        data: { message: 'Could not resolve account' },
      },
    });

    const req = makeRequest({
      accountNumber: '0123456789',
      bankCode: '058',
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.version).toBe('v1');
    expect(body.error.code).toBe('PROVIDER_REJECTED');
    expect(body.error.category).toBe('provider');
    expect(body.message).toBe('Invalid account number or bank code');
  });

  it('returns 429 when rate limit is exceeded with standard retry headers', async () => {
    for (let i = 0; i < 10; i++) {
      await POST(makeRequest({ accountNumber: '0123456789', bankCode: '058' }));
    }

    const limitedRes = await POST(
      makeRequest({ accountNumber: '0123456789', bankCode: '058' }),
    );
    expect(limitedRes.status).toBe(429);
    expect(limitedRes.headers.get('Retry-After')).toBeDefined();
    expect(limitedRes.headers.get('X-RateLimit-Limit')).toBe('10');

    const body = await limitedRes.json();
    expect(body.version).toBe('v1');
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.error.category).toBe('rate_limit');
    expect(body.error.retryable).toBe(true);
  });
});
