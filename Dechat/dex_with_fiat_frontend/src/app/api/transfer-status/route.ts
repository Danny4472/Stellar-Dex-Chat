import { NextRequest, NextResponse } from 'next/server';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { transferStatusSchema } from '@/lib/apiSchemas';
import {
  extractOrGenerateCorrelationId,
  validationError,
  providerError,
  internalError,
  logStructuredError,
} from '@/lib/payout/errors';

const RATE_LIMIT = {
  maxRequests: 15,
  windowMs: 60_000,
  cost: 1,
  burstLimit: 8,
};

export async function POST(request: NextRequest) {
  const correlationId = extractOrGenerateCorrelationId(request.headers);
  const ip = getClientIp(request);

  const limited = applyRateLimit(ip, '/api/transfer-status', RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return validationError({
        message: 'Request body must be valid JSON',
        correlationId,
        code: 'MALFORMED_REQUEST',
      });
    }

    const validationResult = transferStatusSchema.safeParse(body);
    if (!validationResult.success) {
      return validationError({
        message: 'Validation failed',
        correlationId,
        issues: validationResult.error.issues,
      });
    }

    const { reference } = validationResult.data;

    const provider = getPayoutProvider();
    const data = await provider.checkTransferStatus({ reference });

    const response = NextResponse.json({
      success: true,
      data,
    });
    response.headers.set('X-Correlation-Id', correlationId);
    return response;
  } catch (error: unknown) {
    logStructuredError('transfer-status', error, {
      endpoint: '/api/transfer-status',
      correlationId,
      ip: getClientIp(request),
    });

    const httpError =
      error !== null &&
      typeof error === 'object' &&
      'response' in error
        ? (error as {
            response?: { status?: number; data?: { message?: string } };
          })
        : null;

    if (httpError?.response?.data?.message) {
      return providerError({
        error,
        correlationId,
        safeMessage: 'Failed to fetch transfer status from provider.',
        status: 400,
      });
    }

    return internalError({
      error,
      correlationId,
      message: 'Failed to fetch transfer status. Please try again.',
    });
  }
}
