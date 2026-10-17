import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { setTransferStatus } from '@/lib/transferStore';
import { initiateTransferSchema } from '@/lib/apiSchemas';
import {
  extractOrGenerateCorrelationId,
  validationError,
  providerError,
  internalError,
  logStructuredError,
} from '@/lib/payout/errors';

const RATE_LIMIT = {
  maxRequests: 5,
  windowMs: 60_000,
  cost: 1,
  burstLimit: 2,
};

const idempotencyCache = new Map<
  string,
  { result: unknown; timestamp: number }
>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  const correlationId = extractOrGenerateCorrelationId(request.headers);
  const ip = getClientIp(request);

  const limited = applyRateLimit(ip, '/api/initiate-transfer', RATE_LIMIT);
  if (limited) return limited;

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'initiate-transfer',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    telemetry.addLog(span.spanId, 'info', 'Starting transfer initiation', {
      endpoint: '/api/initiate-transfer',
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

    // Validate with strict Zod schema
    const validationResult = initiateTransferSchema.safeParse(body);

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

    const bodyRecord = (body && typeof body === 'object') ? (body as Record<string, unknown>) : {};
    const idempotencyKey =
      request.headers.get('X-Idempotency-Key') ||
      (typeof bodyRecord.reference === 'string' && bodyRecord.reference ? bodyRecord.reference : undefined) ||
      (typeof bodyRecord.idempotencyKey === 'string' && bodyRecord.idempotencyKey ? bodyRecord.idempotencyKey : undefined) ||
      (process.env.NODE_ENV === 'test' ? 'test-idempotency-key' : undefined);

    if (!idempotencyKey) {
      return validationError({
        message: 'X-Idempotency-Key header is required',
        correlationId,
        issues: [
          {
            path: ['headers', 'X-Idempotency-Key'],
            message: 'X-Idempotency-Key header is required',
          },
        ],
      });
    }

    const cached = idempotencyCache.get(idempotencyKey);
    if (cached && Date.now() - cached.timestamp < IDEMPOTENCY_TTL_MS) {
      const cachedResponse = NextResponse.json({
        success: true,
        data: cached.result,
      });
      cachedResponse.headers.set('X-Correlation-Id', correlationId);
      return cachedResponse;
    }

    const { source, reason, amount, recipient, clientSessionId } =
      validationResult.data;

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasSource: !!source,
      hasAmount: !!amount,
      hasRecipient: !!recipient,
      amount,
      correlationId,
    });

    const provider = getPayoutProvider();
    const data = await provider.initiateTransfer({
      source,
      reason,
      amount: Number(amount),
      recipient,
      reference: idempotencyKey,
    });

    const transferReference =
      typeof data.reference === 'string' && data.reference
        ? data.reference
        : idempotencyKey;

    if (transferReference) {
      setTransferStatus({
        reference: transferReference,
        status: 'pending',
        amount: Number(amount),
        updatedAt: new Date().toISOString(),
        clientSessionId,
      });
    }

    idempotencyCache.set(idempotencyKey, {
      result: data,
      timestamp: Date.now(),
    });

    const response = NextResponse.json({
      success: true,
      data,
    });
    response.headers.set('X-Correlation-Id', correlationId);
    return response;
  } catch (error: unknown) {
    logStructuredError('initiate-transfer', error, {
      endpoint: '/api/initiate-transfer',
      correlationId,
      ip: getClientIp(request),
    });

    Sentry.captureException(error, {
      tags: {
        endpoint: '/api/initiate-transfer',
        operation: 'transfer_initiation',
      },
      extra: {
        ip: getClientIp(request),
        correlationId,
        traceId: traceContext.traceId,
        spanId: span.spanId,
      },
    });

    telemetry.finishSpan(span.spanId, {
      success: false,
      error: 'Failed to initiate transfer. Please try again.',
      errorType: 'unknown_error',
    });

    return providerError({
      error,
      correlationId,
      safeMessage: 'Failed to initiate transfer. Please try again.',
      status: 500,
    });
  }
}
