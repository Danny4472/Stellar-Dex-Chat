import { NextRequest, NextResponse } from 'next/server';

import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { transferStatusSchema } from '@/lib/apiSchemas';

import {
  transitionPayoutStatus,
  InvalidPayoutTransitionError,
  type PayoutStatus,
} from '@/lib/transferStore';

const RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 };

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/transfer-status', RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, message: 'Request body must be valid JSON' },
        { status: 400 },
      );
    }

    const validationResult = transferStatusSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          message: 'Validation failed',
          errors: validationResult.error.issues,
        },
        { status: 400 },
      );
    }

    const { reference } = validationResult.data;

    const provider = getPayoutProvider();
    const data = await provider.checkTransferStatus({ reference });

    if (data && typeof data.status === 'string') {
      const normalizedStatus = data.status.toLowerCase() as PayoutStatus;
      try {
        transitionPayoutStatus({
          reference,
          targetStatus: normalizedStatus,
          actor: 'polling',
          providerReference: data.reference ?? reference,
          reason: 'Status polling update',
          amount: typeof data.amount === 'number' ? data.amount : undefined,
        });
      } catch (err) {
        if (err instanceof InvalidPayoutTransitionError) {
          console.warn('Polling transition rejected:', err.message);
        }
      }
    }

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error: unknown) {
    console.error('Transfer status error:', error);

    if (
      error &&
      typeof error === 'object' &&
      'response' in error &&
      error.response &&
      typeof error.response === 'object' &&
      'data' in error.response &&
      error.response.data &&
      typeof error.response.data === 'object' &&
      'message' in error.response.data
    ) {
      return NextResponse.json(
        {
          success: false,
          message: (error.response.data as { message: string }).message,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        message: 'Failed to fetch transfer status. Please try again.',
      },
      { status: 500 },
    );
  }
}
