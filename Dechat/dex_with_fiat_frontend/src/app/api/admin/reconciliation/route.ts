import { NextRequest, NextResponse } from 'next/server';
import { ReconciliationRecord } from '@/types';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { enforceAdminIpAllowlist } from '@/lib/security';
import {
  reconciliationStore,
  reconcileRecords,
  serializeReconciliationReport,
  RepairParams,
} from '@/lib/payout/reconciliation';
import { fromMinorUnits } from '@/lib/payout/minorUnits';

export async function GET(request: NextRequest) {
  try {
    const blockedResponse = enforceAdminIpAllowlist(request);
    if (blockedResponse) return blockedResponse;

    const authError = requireAdminAuth(request);
    if (authError) {
      return authError;
    }

    // Read-only reconciliation job by default (Issue #39)
    const deposits = reconciliationStore.getDeposits();
    const payouts = reconciliationStore.getPayouts();
    const report = reconcileRecords(deposits, payouts);

    // If caller requests structured report format
    const format = request.nextUrl.searchParams.get('format');
    if (format === 'report') {
      return NextResponse.json(serializeReconciliationReport(report));
    }

    // Default: map report to standard ReconciliationRecord[] for dashboard view
    const records: ReconciliationRecord[] = [];
    let counter = 1;

    for (const m of report.matched) {
      records.push({
        id: String(counter++),
        depositTxHash: m.deposit.txHash,
        depositAmount: fromMinorUnits(
          m.deposit.amountMinor,
          m.deposit.currency,
        ),
        depositUser: m.deposit.wallet,
        depositDate: m.deposit.timestamp,
        payoutId: m.payout.payoutId,
        payoutAmount: fromMinorUnits(m.payout.amountMinor, m.payout.currency),
        payoutRecipient: m.payout.recipient,
        payoutStatus: m.payout.payoutStatus,
        payoutDate: m.payout.payoutDate,
        status: 'matched',
      });
    }

    for (const d of report.unmatched.depositsWithoutPayout) {
      records.push({
        id: String(counter++),
        depositTxHash: d.txHash,
        depositAmount: fromMinorUnits(d.amountMinor, d.currency),
        depositUser: d.wallet,
        depositDate: d.timestamp,
        payoutId: '',
        payoutAmount: '',
        payoutRecipient: '',
        payoutStatus: 'pending',
        payoutDate: '',
        status: 'unmatched',
      });
    }

    for (const p of report.unmatched.payoutsWithoutDeposit) {
      records.push({
        id: String(counter++),
        depositTxHash: '',
        depositAmount: '',
        depositUser: '',
        depositDate: '',
        payoutId: p.payoutId,
        payoutAmount: fromMinorUnits(p.amountMinor, p.currency),
        payoutRecipient: p.recipient,
        payoutStatus: p.payoutStatus,
        payoutDate: p.payoutDate,
        status: 'unmatched',
      });
    }

    for (const mm of report.amountMismatched) {
      records.push({
        id: String(counter++),
        depositTxHash: mm.deposit.txHash,
        depositAmount: fromMinorUnits(
          mm.deposit.amountMinor,
          mm.deposit.currency,
        ),
        depositUser: mm.deposit.wallet,
        depositDate: mm.deposit.timestamp,
        payoutId: mm.payout.payoutId,
        payoutAmount: fromMinorUnits(mm.payout.amountMinor, mm.payout.currency),
        payoutRecipient: mm.payout.recipient,
        payoutStatus: mm.payout.payoutStatus,
        payoutDate: mm.payout.payoutDate,
        status: 'error',
      });
    }

    for (const dup of report.duplicated) {
      for (const d of dup.deposits) {
        records.push({
          id: String(counter++),
          depositTxHash: d.txHash,
          depositAmount: fromMinorUnits(d.amountMinor, d.currency),
          depositUser: d.wallet,
          depositDate: d.timestamp,
          payoutId: dup.payouts[0]?.payoutId || '',
          payoutAmount: dup.payouts[0]
            ? fromMinorUnits(
                dup.payouts[0].amountMinor,
                dup.payouts[0].currency,
              )
            : '',
          payoutRecipient: dup.payouts[0]?.recipient || '',
          payoutStatus: dup.payouts[0]?.payoutStatus || 'pending',
          payoutDate: dup.payouts[0]?.payoutDate || '',
          status: 'error',
        });
      }
    }

    return NextResponse.json(records);
  } catch (error) {
    console.error('Error fetching reconciliation data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch reconciliation data' },
      { status: 500 },
    );
  }
}

/**
 * Explicit audited action to repair reconciliation records (Issue #39).
 */
export async function POST(request: NextRequest) {
  try {
    const blockedResponse = enforceAdminIpAllowlist(request);
    if (blockedResponse) return blockedResponse;

    const authError = requireAdminAuth(request);
    if (authError) {
      return authError;
    }

    const body = (await request
      .json()
      .catch(() => ({}))) as Partial<RepairParams>;
    const { action, withdrawalRequestId, reason } = body;

    if (!action || !reason) {
      return NextResponse.json(
        {
          error:
            'Missing required repair parameters: action and reason are mandatory',
        },
        { status: 400 },
      );
    }

    const operatorAddress =
      request.headers.get('x-admin-address') ||
      request.headers.get('x-admin-token') ||
      'admin_operator';

    const result = reconciliationStore.repair(
      body as RepairParams,
      operatorAddress,
    );

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error: unknown) {
    console.error('Error repairing reconciliation record:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to repair record';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
