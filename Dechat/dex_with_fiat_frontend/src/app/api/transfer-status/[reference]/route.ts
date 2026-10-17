import { NextRequest, NextResponse } from 'next/server';
import {
  getTransferStatus,
  isTransferAuthorized,
  setTransferStatus,
} from '@/lib/transferStore';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import {
  nonEnumeratingNotFoundResponse,
  resolveCallerIdentity,
  unauthorizedResponse,
} from '@/lib/payout/auth';

const RATE_LIMIT = { maxRequests: 5, windowMs: 60_000 };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/transfer-status', RATE_LIMIT);
  if (limited) return limited;

  try {
    const caller = await resolveCallerIdentity(request);
    if (!caller) {
      return unauthorizedResponse('Authentication required to cancel transfer');
    }

    const p = await params;
    const { reference } = p;

    if (!reference) {
      return NextResponse.json(
        { success: false, message: 'Reference is required' },
        { status: 400 },
      );
    }

    const existing = getTransferStatus(reference);

    // Non-enumerating error: Return the exact same 404 for unknown AND unauthorized references
    if (!existing || !isTransferAuthorized(existing, caller)) {
      return nonEnumeratingNotFoundResponse('Transfer');
    }

    if (existing.status !== 'pending') {
      return NextResponse.json(
        { success: false, message: 'Only pending transfers can be cancelled' },
        { status: 409 },
      );
    }

    const updated = setTransferStatus({
      ...existing,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      success: true,
      data: {
        reference: updated.reference,
        status: updated.status,
        message: 'Transfer cancellation requested successfully',
      },
    });
  } catch (error: unknown) {
    console.error('Cancel transfer error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to cancel transfer' },
      { status: 500 },
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  try {
    const caller = await resolveCallerIdentity(request);
    if (!caller) {
      return unauthorizedResponse(
        'Authentication required to view transfer status',
      );
    }

    const p = await params;
    const { reference } = p;

    if (!reference) {
      return NextResponse.json(
        { success: false, message: 'Reference is required' },
        { status: 400 },
      );
    }

    const existing = getTransferStatus(reference);

    // Non-enumerating error: Return the exact same 404 for unknown AND unauthorized references
    if (!existing || !isTransferAuthorized(existing, caller)) {
      return nonEnumeratingNotFoundResponse('Transfer');
    }

    return NextResponse.json({
      success: true,
      data: {
        ...existing,
        amountMinor:
          existing.amountMinor !== undefined
            ? existing.amountMinor.toString()
            : undefined,
      },
    });
  } catch (error: unknown) {
    console.error('Get transfer status error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to retrieve transfer status' },
      { status: 500 },
    );
  }
}
