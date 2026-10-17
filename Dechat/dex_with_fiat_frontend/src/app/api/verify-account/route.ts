import { NextRequest, NextResponse } from 'next/server';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { verifyAccountSchema } from '@/lib/apiSchemas';
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

  const limited = applyRateLimit(ip, '/api/verify-account', RATE_LIMIT);
  if (limited) return limited;

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'verify-account',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    telemetry.addLog(span.spanId, 'info', 'Starting account verification', {
      endpoint: '/api/verify-account',
      correlationId,
    });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      telemetry.addLog(span.spanId, 'warn', 'Request body is not valid JSON', {
        endpoint: '/api/verify-account',
        correlationId,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON body',
      });

      return validationError({
        message: 'Request body must be valid JSON',
        correlationId,
        code: 'MALFORMED_REQUEST',
      });
    }

    // Validate with strict server-side Zod schema
    const validationResult = verifyAccountSchema.safeParse(body);

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

    const { accountNumber, bankCode } = validationResult.data;

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasAccountNumber: !!accountNumber,
      hasBankCode: !!bankCode,
      bankCode: bankCode,
      correlationId,
    });

    const provider = getPayoutProvider();
    const data = await provider.verifyAccount({ accountNumber, bankCode });

    telemetry.finishSpan(span.spanId, { success: true });

    const apiResponse = NextResponse.json({ success: true, data });
    apiResponse.headers.set('X-Correlation-Id', correlationId);
    telemetry.setTraceHeaders(apiResponse.headers, traceContext);
    return apiResponse;
  } catch (error: unknown) {
    logStructuredError('verify-account', error, {
      endpoint: '/api/verify-account',
      correlationId,
      ip: getClientIp(request),
    });

    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in account verification',
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

    if (httpError?.response?.status === 422) {
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid account number or bank code',
        errorType: 'validation_error',
      });
      return providerError({
        error,
        correlationId,
        safeMessage: 'Invalid account number or bank code',
        status: 400,
      });
    }

    if (httpError?.response?.data?.message) {
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Provider error',
        errorType: 'paystack_api_error',
      });
      return providerError({
        error,
        correlationId,
        safeMessage: 'Account verification failed at provider. Please try again.',
        status: 400,
      });
    }

    telemetry.finishSpan(span.spanId, {
      success: false,
      error: 'Account verification failed. Please try again.',
      errorType: 'unknown_error',
    });

    return internalError({
      error,
      correlationId,
      message: 'Account verification failed. Please try again.',
    });
  }
}
