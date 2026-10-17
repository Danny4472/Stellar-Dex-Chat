import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { transitionPayoutStatus } from '@/lib/transferStore';
import { initiateTransferSchema } from '@/lib/apiSchemas';
import {
  executeIdempotentPayout,
  IdempotencyPayloadMismatchError,
  ConcurrentRequestInProgressError,
} from '@/lib/payout/idempotency';

const RATE_LIMIT = { maxRequests: 3, windowMs: 60_000 };

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/initiate-transfer', RATE_LIMIT);
  if (limited) return limited;

  const idempotencyKey =
    request.headers.get('x-idempotency-key') ||
    request.headers.get('idempotency-key');

  if (!idempotencyKey) {
    return NextResponse.json(
      { success: false, message: 'X-Idempotency-Key header is required' },
      { status: 400 },
    );
  }

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'initiate-transfer',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    telemetry.addLog(span.spanId, 'info', 'Starting transfer initiation', {
      endpoint: '/api/initiate-transfer',
    });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      telemetry.addLog(span.spanId, 'warn', 'Malformed JSON body');
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON body',
      });
      return NextResponse.json(
        { success: false, message: 'Invalid JSON in request body.' },
        { status: 400 },
      );
    }

    // Validate with Zod
    const validationResult = initiateTransferSchema.safeParse(body);

    if (!validationResult.success) {
      telemetry.addLog(span.spanId, 'warn', 'Zod validation failed', {
        errors: validationResult.error.issues,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Validation failed',
      });

      return NextResponse.json(
        {
          success: false,
          message: 'Validation failed',
          errors: validationResult.error.issues,
        },
        { status: 400 },
      );
    }

    const { source, reason, amount, recipient } = validationResult.data;
    const bodyRecord = body as Record<string, unknown>;
    const clientSessionId =
      typeof bodyRecord.clientSessionId === 'string'
        ? bodyRecord.clientSessionId
        : undefined;

    const userId =
      request.headers.get('x-user-id') ||
      request.headers.get('x-wallet-address') ||
      clientSessionId ||
      ip ||
      'default-user';

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasSource: !!source,
      hasAmount: !!amount,
      hasRecipient: !!recipient,
      amount,
    });

    // Execute through idempotency layer scoped to user and payout intent
    const { isRetry, data } = await executeIdempotentPayout({
      idempotencyKey,
      userId,
      payload: { source, reason, amount, recipient },
      execute: async () => {
        const provider = getPayoutProvider();
        const responseData = await provider.initiateTransfer({
          source,
          reason,
          amount,
          recipient,
          reference: idempotencyKey, // Pass stable idempotency reference to provider
        });

        const transferReference =
          typeof responseData.reference === 'string' && responseData.reference
            ? responseData.reference
            : idempotencyKey;

        if (transferReference) {
          transitionPayoutStatus({
            reference: transferReference,
            targetStatus: 'pending',
            actor: 'user',
            providerReference: transferReference,
            reason: 'Payout initiation',
            amount: Number(amount),
            clientSessionId,
          });
        }

        return responseData;
      },
    });

    telemetry.addLog(span.spanId, 'info', 'Transfer initiation completed', {
      isRetry,
      reference: idempotencyKey,
    });
    telemetry.finishSpan(span.spanId, { success: true });

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error: unknown) {
    if (error instanceof IdempotencyPayloadMismatchError) {
      telemetry.addLog(span.spanId, 'warn', 'Idempotency key reused with different payload', {
        idempotencyKey,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: error.message,
      });
      return NextResponse.json(
        {
          success: false,
          message: 'Idempotency key reuse with different payload',
        },
        { status: 422 },
      );
    }

    if (error instanceof ConcurrentRequestInProgressError) {
      telemetry.addLog(span.spanId, 'warn', 'Concurrent duplicate payout request in progress', {
        idempotencyKey,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: error.message,
      });
      return NextResponse.json(
        {
          success: false,
          message: 'A request with this idempotency key is currently in progress',
        },
        { status: 409 },
      );
    }

    Sentry.captureException(error, {
      tags: {
        endpoint: '/api/initiate-transfer',
        operation: 'transfer_initiation',
      },
      extra: {
        ip,
        traceId: traceContext.traceId,
        spanId: span.spanId,
      },
    });

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in transfer initiation',
      { error: errorMessage },
    );

    console.error('Initiate transfer error:', error);

    telemetry.finishSpan(span.spanId, {
      success: false,
      error: 'Failed to initiate transfer. Please try again.',
      errorType: 'unknown_error',
    });

    return NextResponse.json(
      {
        success: false,
        message: 'Failed to initiate transfer. Please try again.',
      },
      { status: 500 },
    );
  }
}
