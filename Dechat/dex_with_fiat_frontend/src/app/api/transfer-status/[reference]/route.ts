import { NextRequest, NextResponse } from 'next/server';
import { getTransferStatus } from '@/lib/transferStore';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import {
  executeCancellationSaga,
  getSagaStepsForPayout,
} from '@/lib/payout/cancellationSaga';
import {
  createPayoutErrorResponse,
  extractOrGenerateCorrelationId,
  internalError,
  validationError,
  authorizationError,
} from '@/lib/payout/errors';

const RATE_LIMIT = { maxRequests: 5, windowMs: 60_000 };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  const correlationId = extractOrGenerateCorrelationId(request.headers);
  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/transfer-status', RATE_LIMIT, {
    correlationId,
  });
  if (limited) return limited;

  try {
    const p = await params;
    const { reference } = p;

    if (!reference) {
      return validationError({
        message: 'Reference is required',
        correlationId,
        issues: [{ path: ['reference'], message: 'Reference is required' }],
      });
    }

    const body = await request.json().catch(() => ({}));
    const clientSessionId = (body as Record<string, unknown>).clientSessionId as
      | string
      | undefined;
    const reason = (body as Record<string, unknown>).reason as
      | string
      | undefined;

    const sagaResult = await executeCancellationSaga({
      reference,
      clientSessionId,
      reason,
    });

    if (!sagaResult.success) {
      if (sagaResult.status === 403) {
        return authorizationError({
          status: 403,
          message: sagaResult.message,
          correlationId,
        });
      }

      return createPayoutErrorResponse({
        status: sagaResult.status,
        code: (sagaResult.code as any) || 'CANCELLATION_REJECTED',
        userMessage: sagaResult.message,
        category:
          sagaResult.status === 404
            ? 'validation'
            : sagaResult.status === 403
              ? 'authorization'
              : 'provider',
        retryable: false,
        correlationId,
      });
    }

    const response = NextResponse.json(
      {
        success: true,
        data: sagaResult.data || {
          reference,
          status: sagaResult.outcome === 'provider_confirmed' ? 'cancelled' : 'pending',
          outcome: sagaResult.outcome,
          message: sagaResult.message,
        },
      },
      { status: sagaResult.status },
    );

    response.headers.set('X-Correlation-Id', correlationId);
    return response;
  } catch (error: unknown) {
    console.error('Cancel transfer error:', error);
    return internalError({
      error,
      correlationId,
      message: 'Failed to cancel transfer',
    });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  const correlationId = extractOrGenerateCorrelationId(request.headers);

  try {
    const p = await params;
    const { reference } = p;

    if (!reference) {
      return validationError({
        message: 'Reference is required',
        correlationId,
        issues: [{ path: ['reference'], message: 'Reference is required' }],
      });
    }

    const transferRecord = getTransferStatus(reference);
    const sagaSteps = getSagaStepsForPayout(reference);

    if (transferRecord) {
      const response = NextResponse.json({
        success: true,
        data: {
          ...transferRecord,
          sagaSteps: sagaSteps.length > 0 ? sagaSteps : undefined,
        },
      });
      response.headers.set('X-Correlation-Id', correlationId);
      return response;
    }

    const response = NextResponse.json({
      success: true,
      data: {
        reference,
        status: 'pending',
      },
    });
    response.headers.set('X-Correlation-Id', correlationId);
    return response;
  } catch (error: unknown) {
    console.error('Get transfer status error:', error);
    return internalError({
      error,
      correlationId,
      message: 'Failed to retrieve transfer status',
    });
  }
}
