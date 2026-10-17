import { NextRequest, NextResponse } from 'next/server';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { createRecipientSchema } from '@/lib/apiSchemas';
import {
  extractOrGenerateCorrelationId,
  validationError,
  providerError,
  internalError,
  logStructuredError,
} from '@/lib/payout/errors';

const RATE_LIMIT = {
  maxRequests: 10,
  windowMs: 60_000,
  cost: 1,
  burstLimit: 5,
};

export async function POST(request: NextRequest) {
  const correlationId = extractOrGenerateCorrelationId(request.headers);
  const ip = getClientIp(request);

  const limited = applyRateLimit(ip, '/api/create-recipient', RATE_LIMIT);
  if (limited) return limited;

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'create-recipient',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    telemetry.addLog(span.spanId, 'info', 'Starting recipient creation', {
      endpoint: '/api/create-recipient',
      correlationId,
    });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      telemetry.addLog(span.spanId, 'warn', 'Malformed JSON body', {
        correlationId,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON body',
      });

      return validationError({
        message: 'Invalid JSON in request body.',
        correlationId,
        code: 'MALFORMED_REQUEST',
      });
    }

    // Validate with strict server-side Zod schema
    const validationResult = createRecipientSchema.safeParse(body);

    if (!validationResult.success) {
      telemetry.addLog(span.spanId, 'warn', 'Zod validation failed', {
        errors: validationResult.error.issues,
        correlationId,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Validation failed',
      });

      return validationError({
        message: 'Validation failed',
        correlationId,
        issues: validationResult.error.issues,
      });
    }

    const { type, name, account_number, bank_code, currency, description } =
      validationResult.data;

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasType: !!type,
      hasName: !!name,
      currency,
      correlationId,
    });

    const provider = getPayoutProvider();
    const data = await provider.createRecipient({
      type,
      name,
      account_number,
      bank_code,
      currency,
      ...(description ? { description } : {}),
    });

    telemetry.finishSpan(span.spanId, { success: true });

    const apiResponse = NextResponse.json({
      success: true,
      data,
    });
    apiResponse.headers.set('X-Correlation-Id', correlationId);
    telemetry.setTraceHeaders(apiResponse.headers, traceContext);
    return apiResponse;
  } catch (error: unknown) {
    logStructuredError('create-recipient', error, {
      endpoint: '/api/create-recipient',
      correlationId,
      ip: getClientIp(request),
    });

    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in recipient creation',
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        correlationId,
      },
    );

    const httpError =
      error !== null &&
      typeof error === 'object' &&
      'response' in error
        ? (error as {
            response?: { status?: number; data?: { message?: string } };
          })
        : null;

    if (httpError?.response?.data?.message) {
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Provider error',
        errorType: 'paystack_api_error',
      });
      return providerError({
        error,
        correlationId,
        safeMessage: 'Failed to create recipient at payment provider.',
        status: 400,
      });
    }

    telemetry.finishSpan(span.spanId, {
      success: false,
      error: 'Failed to create recipient. Please try again.',
      errorType: 'unknown_error',
    });

    return internalError({
      error,
      correlationId,
      message: 'Failed to create recipient. Please try again.',
    });
  }
}
