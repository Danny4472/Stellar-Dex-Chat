import { NextRequest, NextResponse } from 'next/server';
import { telemetry } from '@/lib/telemetry';
import {
  isReplayEvent,
  getTransferStatus,
  transitionPayoutStatus,
  InvalidPayoutTransitionError,
} from '@/lib/transferStore';
import { publishPaymentStatus } from '@/lib/paymentStatusEvents';
import { verifyWebhookSignature } from '@/lib/payout/webhookSignature';

interface PaystackWebhookData {
  id?: string;
  reference: string;
  amount: number;
  recipient: string;
  status: string;
  failure_reason?: string;
}

interface PaystackWebhookEvent {
  event: string;
  data: PaystackWebhookData;
}

export async function POST(request: NextRequest) {
  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'webhook-handler',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    telemetry.addLog(span.spanId, 'info', 'Starting webhook processing', {
      endpoint: '/api/webhook',
    });

    const payload = await request.text();
    const signature = request.headers.get('x-paystack-signature');
    const timestamp =
      request.headers.get('x-paystack-signature-timestamp') ||
      request.headers.get('x-webhook-timestamp');

    telemetry.addLog(span.spanId, 'info', 'Webhook request parsed', {
      hasSignature: !!signature,
      payloadLength: payload.length,
    });

    // Step 1: Verify exact raw payload using constant-time signature comparison.
    // Rejects missing, malformed, stale, or invalid signatures without domain parsing.
    const verification = verifyWebhookSignature({
      rawPayload: payload,
      signature,
      timestamp,
    });

    if (!verification.valid) {
      telemetry.addLog(span.spanId, 'error', 'Invalid webhook signature', {
        error: verification.error,
        message: verification.message,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: verification.message ?? 'Invalid signature',
      });

      console.error('Webhook signature verification failed:', verification.message);
      const status = verification.error === 'missing_secret' ? 400 : 401;
      return NextResponse.json(
        { message: verification.message ?? 'Invalid signature' },
        { status },
      );
    }

    telemetry.addLog(span.spanId, 'info', 'Webhook signature verified', {
      endpoint: '/api/webhook',
    });

    // Step 2: Parse payload into domain state only AFTER signature verification has passed
    let event: PaystackWebhookEvent;
    try {
      event = JSON.parse(payload) as PaystackWebhookEvent;
    } catch {
      telemetry.addLog(span.spanId, 'warn', 'Webhook payload is not valid JSON', {
        endpoint: '/api/webhook',
        payloadLength: payload.length,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON payload',
        errorType: 'parse_error',
      });
      return NextResponse.json(
        { message: 'Webhook payload must be valid JSON' },
        { status: 400 },
      );
    }

    const dataId = event?.data?.id;
    const dataRef = event?.data?.reference;
    if (!dataId && !dataRef) {
      telemetry.addLog(span.spanId, 'error', 'Missing event data id and reference', {
        eventType: event.event,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Missing event data id and reference',
      });
      return NextResponse.json(
        { message: 'Event data must contain id or reference' },
        { status: 400 },
      );
    }
    const replayKey = `${event.event}:${dataId ?? dataRef}`;

    console.log('Received Paystack webhook:', event.event);

    // Step 3: Handle events with explicit payout lifecycle state transitions
    switch (event.event) {
      case 'transfer.success': {
        const data = event.data ?? {};
        const reference = data.reference ?? '';
        const existingRecord = getTransferStatus(reference);
        const updatedAt = new Date().toISOString();

        telemetry.addLog(span.spanId, 'info', 'Processing transfer success', {
          reference,
          amount: data.amount,
          recipient: data.recipient,
          status: data.status,
        });

        try {
          const nextRecord = transitionPayoutStatus({
            reference,
            targetStatus: 'success',
            actor: 'webhook',
            providerReference: data.id ?? reference,
            reason: 'Webhook event transfer.success',
            amount: data.amount,
            clientSessionId: existingRecord?.clientSessionId,
            timestamp: updatedAt,
          });

          publishPaymentStatus(nextRecord.clientSessionId, {
            reference: nextRecord.reference,
            status: nextRecord.status,
            amount: nextRecord.amount,
            updatedAt,
          });
        } catch (error) {
          if (error instanceof InvalidPayoutTransitionError) {
            telemetry.addLog(span.spanId, 'warn', 'Rejected invalid webhook transition', {
              error: error.message,
              reference,
            });
            console.warn('Rejected out-of-order webhook transition:', error.message);
          } else {
            throw error;
          }
        }
        break;
      }

      case 'transfer.failed': {
        const data = event.data ?? {};
        const reference = data.reference ?? '';
        const existingRecord = getTransferStatus(reference);
        const updatedAt = new Date().toISOString();

        telemetry.addLog(span.spanId, 'warn', 'Processing transfer failure', {
          reference,
          amount: data.amount,
          recipient: data.recipient,
          status: data.status,
          failureReason: data.failure_reason,
        });

        try {
          const nextRecord = transitionPayoutStatus({
            reference,
            targetStatus: 'failed',
            actor: 'webhook',
            providerReference: data.id ?? reference,
            reason: data.failure_reason ?? 'Webhook event transfer.failed',
            amount: data.amount,
            clientSessionId: existingRecord?.clientSessionId,
            failureReason: data.failure_reason,
            timestamp: updatedAt,
          });

          publishPaymentStatus(nextRecord.clientSessionId, {
            reference: nextRecord.reference,
            status: nextRecord.status,
            amount: nextRecord.amount,
            updatedAt,
            failureReason: nextRecord.failureReason,
          });
        } catch (error) {
          if (error instanceof InvalidPayoutTransitionError) {
            telemetry.addLog(span.spanId, 'warn', 'Rejected invalid webhook transition', {
              error: error.message,
              reference,
            });
            console.warn('Rejected out-of-order webhook transition:', error.message);
          } else {
            throw error;
          }
        }
        break;
      }

      case 'transfer.reversed': {
        const data = event.data ?? {};
        const reference = data.reference ?? '';
        const existingRecord = getTransferStatus(reference);
        const updatedAt = new Date().toISOString();

        telemetry.addLog(span.spanId, 'info', 'Processing transfer reversal', {
          reference,
          amount: data.amount,
          recipient: data.recipient,
          status: data.status,
        });

        try {
          const nextRecord = transitionPayoutStatus({
            reference,
            targetStatus: 'reversed',
            actor: 'webhook',
            providerReference: data.id ?? reference,
            reason: 'Webhook event transfer.reversed',
            amount: data.amount,
            clientSessionId: existingRecord?.clientSessionId,
            timestamp: updatedAt,
          });

          publishPaymentStatus(nextRecord.clientSessionId, {
            reference: nextRecord.reference,
            status: nextRecord.status,
            amount: nextRecord.amount,
            updatedAt,
          });
        } catch (error) {
          if (error instanceof InvalidPayoutTransitionError) {
            telemetry.addLog(span.spanId, 'warn', 'Rejected invalid webhook transition', {
              error: error.message,
              reference,
            });
            console.warn('Rejected out-of-order webhook transition:', error.message);
          } else {
            throw error;
          }
        }
        break;
      }

      default:
        telemetry.addLog(span.spanId, 'info', 'Unhandled webhook event', {
          eventType: event.event,
        });
        console.log('Unhandled webhook event:', event.event);
    }

    isReplayEvent(replayKey);

    telemetry.addLog(span.spanId, 'info', 'Webhook processing completed', {
      eventType: event.event,
    });
    telemetry.finishSpan(span.spanId, { success: true });

    const response = NextResponse.json({ received: true });
    telemetry.setTraceHeaders(response.headers, traceContext);
    return response;
  } catch (error) {
    telemetry.addLog(span.spanId, 'error', 'Webhook processing error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    telemetry.finishSpan(span.spanId, {
      success: false,
      error: 'Webhook processing failed',
      errorType: 'processing_error',
    });

    console.error('Webhook processing error:', error);
    return NextResponse.json(
      { message: 'Webhook processing failed' },
      { status: 500 },
    );
  }
}
