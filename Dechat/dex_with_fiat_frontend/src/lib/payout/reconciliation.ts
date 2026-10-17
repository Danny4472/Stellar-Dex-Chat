/**
 * @fileoverview On-chain escrow receipt and off-chain fiat payout reconciliation engine.
 *
 * Connects the escrow receipt lifecycle to the fiat payout lifecycle so operators can
 * identify crypto deposits without a matching transfer and vice versa.
 *
 * Implements stable linkage keys, mismatch classification (unmatched, duplicated,
 * amount-mismatched), read-only inspection by default, and audited repair actions.
 */

import AuditLogService from '@/lib/auditLog';

export interface EscrowDepositReceipt {
  receiptId: string;
  withdrawalRequestId: string;
  txHash: string;
  amountMinor: bigint;
  currency: string;
  wallet: string;
  timestamp: string;
  status: 'deposited' | 'released' | 'refunded';
}

export interface OffChainPayoutRecord {
  payoutId: string;
  withdrawalRequestId: string;
  providerReference: string;
  receiptId?: string;
  amountMinor: bigint;
  currency: string;
  recipient: string;
  payoutStatus: 'pending' | 'completed' | 'failed' | 'reversed' | 'cancelled';
  payoutDate: string;
  repaired?: boolean;
  repairNote?: string;
}

export interface MatchedPair {
  linkageKey: string;
  deposit: EscrowDepositReceipt;
  payout: OffChainPayoutRecord;
  amountMinor: string;
  currency: string;
}

export interface AmountMismatchPair {
  linkageKey: string;
  deposit: EscrowDepositReceipt;
  payout: OffChainPayoutRecord;
  depositAmountMinor: string;
  payoutAmountMinor: string;
  differenceMinor: string;
  currency: string;
}

export interface DuplicateGroup {
  linkageKey: string;
  deposits: EscrowDepositReceipt[];
  payouts: OffChainPayoutRecord[];
  reason: 'multiple_deposits' | 'multiple_payouts' | 'multiple_both';
}

export interface ReconciliationReport {
  timestamp: string;
  summary: {
    totalDeposits: number;
    totalPayouts: number;
    matchedCount: number;
    unmatchedDepositCount: number;
    unmatchedPayoutCount: number;
    duplicateCount: number;
    amountMismatchCount: number;
  };
  matched: MatchedPair[];
  unmatched: {
    depositsWithoutPayout: EscrowDepositReceipt[];
    payoutsWithoutDeposit: OffChainPayoutRecord[];
  };
  duplicated: DuplicateGroup[];
  amountMismatched: AmountMismatchPair[];
}

/**
 * Generates a stable linkage key across receipt ID, withdrawal request ID,
 * payout ID, and provider reference.
 */
export function createLinkageKey(input: {
  receiptId?: string;
  withdrawalRequestId?: string;
  payoutId?: string;
  providerReference?: string;
}): string {
  if (input.withdrawalRequestId && input.withdrawalRequestId.trim()) {
    return input.withdrawalRequestId.trim();
  }
  if (input.receiptId && input.providerReference) {
    return `${input.receiptId.trim()}:${input.providerReference.trim()}`;
  }
  if (input.receiptId) {
    return `rcpt:${input.receiptId.trim()}`;
  }
  if (input.payoutId) {
    return `pay:${input.payoutId.trim()}`;
  }
  if (input.providerReference) {
    return `prov:${input.providerReference.trim()}`;
  }
  return 'unknown_linkage';
}

/**
 * Pure read-only reconciliation job that compares escrow deposit receipts with
 * off-chain payout records, categorizing records into matched, unmatched,
 * duplicated, and amount-mismatched.
 */
export function reconcileRecords(
  deposits: EscrowDepositReceipt[],
  payouts: OffChainPayoutRecord[],
): ReconciliationReport {
  const depositMap = new Map<string, EscrowDepositReceipt[]>();
  const payoutMap = new Map<string, OffChainPayoutRecord[]>();

  // Group deposits by linkage key
  for (const dep of deposits) {
    const key = createLinkageKey({
      receiptId: dep.receiptId,
      withdrawalRequestId: dep.withdrawalRequestId,
    });
    const list = depositMap.get(key) || [];
    list.push(dep);
    depositMap.set(key, list);
  }

  // Group payouts by linkage key
  for (const pay of payouts) {
    const key = createLinkageKey({
      receiptId: pay.receiptId,
      withdrawalRequestId: pay.withdrawalRequestId,
      payoutId: pay.payoutId,
      providerReference: pay.providerReference,
    });
    const list = payoutMap.get(key) || [];
    list.push(pay);
    payoutMap.set(key, list);
  }

  const allKeys = new Set([...depositMap.keys(), ...payoutMap.keys()]);

  const matched: MatchedPair[] = [];
  const depositsWithoutPayout: EscrowDepositReceipt[] = [];
  const payoutsWithoutDeposit: OffChainPayoutRecord[] = [];
  const duplicated: DuplicateGroup[] = [];
  const amountMismatched: AmountMismatchPair[] = [];

  for (const key of allKeys) {
    const deps = depositMap.get(key) || [];
    const pays = payoutMap.get(key) || [];

    // 1. Check for duplicates (multiple deposits or multiple payouts sharing linkage key)
    if (deps.length > 1 || pays.length > 1) {
      let reason: DuplicateGroup['reason'] = 'multiple_both';
      if (deps.length > 1 && pays.length <= 1) reason = 'multiple_deposits';
      else if (pays.length > 1 && deps.length <= 1) reason = 'multiple_payouts';

      duplicated.push({
        linkageKey: key,
        deposits: deps,
        payouts: pays,
        reason,
      });
      continue;
    }

    // 2. Unmatched deposit
    if (deps.length === 1 && pays.length === 0) {
      depositsWithoutPayout.push(deps[0]);
      continue;
    }

    // 3. Unmatched payout
    if (pays.length === 1 && deps.length === 0) {
      payoutsWithoutDeposit.push(pays[0]);
      continue;
    }

    // 4. Exactly 1 deposit and 1 payout
    if (deps.length === 1 && pays.length === 1) {
      const dep = deps[0];
      const pay = pays[0];

      if (
        dep.amountMinor === pay.amountMinor &&
        dep.currency === pay.currency
      ) {
        matched.push({
          linkageKey: key,
          deposit: dep,
          payout: pay,
          amountMinor: dep.amountMinor.toString(),
          currency: dep.currency,
        });
      } else {
        const diff = dep.amountMinor - pay.amountMinor;
        amountMismatched.push({
          linkageKey: key,
          deposit: dep,
          payout: pay,
          depositAmountMinor: dep.amountMinor.toString(),
          payoutAmountMinor: pay.amountMinor.toString(),
          differenceMinor: diff.toString(),
          currency: dep.currency,
        });
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalDeposits: deposits.length,
      totalPayouts: payouts.length,
      matchedCount: matched.length,
      unmatchedDepositCount: depositsWithoutPayout.length,
      unmatchedPayoutCount: payoutsWithoutDeposit.length,
      duplicateCount: duplicated.length,
      amountMismatchCount: amountMismatched.length,
    },
    matched,
    unmatched: {
      depositsWithoutPayout,
      payoutsWithoutDeposit,
    },
    duplicated,
    amountMismatched,
  };
}

/**
 * Safely converts BigInt values to string representation for JSON serialization.
 */
export function serializeReconciliationReport(
  report: ReconciliationReport,
): unknown {
  return JSON.parse(
    JSON.stringify(report, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}

export type RepairActionType =
  | 'link_records'
  | 'override_amount'
  | 'mark_refunded'
  | 'void_duplicate';

export interface RepairParams {
  action: RepairActionType;
  withdrawalRequestId: string;
  depositReceiptId?: string;
  payoutId?: string;
  reason: string;
  adjustedAmountMinor?: string;
}

export interface RepairResult {
  success: boolean;
  message: string;
  repairedRecordId: string;
  auditLogId: string;
}

/**
 * In-memory repository for reconciliation records to allow audited repair actions.
 */
class ReconciliationStore {
  private deposits = new Map<string, EscrowDepositReceipt>();
  private payouts = new Map<string, OffChainPayoutRecord>();

  constructor() {
    this.seedDefaultRecords();
  }

  reset() {
    this.deposits.clear();
    this.payouts.clear();
    this.seedDefaultRecords();
  }

  clear() {
    this.deposits.clear();
    this.payouts.clear();
  }

  addDeposit(deposit: EscrowDepositReceipt) {
    this.deposits.set(deposit.receiptId, deposit);
  }

  addPayout(payout: OffChainPayoutRecord) {
    this.payouts.set(payout.payoutId, payout);
  }

  getDeposits(): EscrowDepositReceipt[] {
    return Array.from(this.deposits.values());
  }

  getPayouts(): OffChainPayoutRecord[] {
    return Array.from(this.payouts.values());
  }

  private seedDefaultRecords() {
    this.addDeposit({
      receiptId: 'rcpt_001',
      withdrawalRequestId: 'wr_001',
      txHash: '0x123abc',
      amountMinor: 10000n, // 100.00 NGN
      currency: 'NGN',
      wallet: 'GA123...',
      timestamp: '2026-03-20T10:00:00Z',
      status: 'deposited',
    });

    this.addPayout({
      payoutId: 'TRF_123456',
      withdrawalRequestId: 'wr_001',
      providerReference: 'PROV_123456',
      receiptId: 'rcpt_001',
      amountMinor: 10000n,
      currency: 'NGN',
      recipient: 'John Doe - 1234567890',
      payoutStatus: 'completed',
      payoutDate: '2026-03-20T11:00:00Z',
    });

    // Unmatched deposit fixture
    this.addDeposit({
      receiptId: 'rcpt_unmatched_002',
      withdrawalRequestId: 'wr_unmatched_002',
      txHash: '0x789ghi',
      amountMinor: 2500n,
      currency: 'NGN',
      wallet: 'GA789...',
      timestamp: '2026-03-22T09:15:00Z',
      status: 'deposited',
    });

    // Amount mismatched fixture
    this.addDeposit({
      receiptId: 'rcpt_mismatch_003',
      withdrawalRequestId: 'wr_mismatch_003',
      txHash: '0xabcpqr',
      amountMinor: 7500n,
      currency: 'NGN',
      wallet: 'GAABC...',
      timestamp: '2026-03-23T16:45:00Z',
      status: 'deposited',
    });

    this.addPayout({
      payoutId: 'TRF_345678',
      withdrawalRequestId: 'wr_mismatch_003',
      providerReference: 'PROV_345678',
      receiptId: 'rcpt_mismatch_003',
      amountMinor: 7000n, // 70.00 vs 75.00
      currency: 'NGN',
      recipient: 'Bob Wilson - 1122334455',
      payoutStatus: 'failed',
      payoutDate: '2026-03-23T17:00:00Z',
    });
  }

  /**
   * Executes an audited repair action.
   */
  repair(params: RepairParams, operatorAddress: string): RepairResult {
    if (!params.reason || params.reason.trim().length < 5) {
      throw new Error('A detailed audit reason is required for repair actions');
    }

    let repairedId = '';
    const beforeState: Record<string, unknown> = {};
    const afterState: Record<string, unknown> = {};

    switch (params.action) {
      case 'link_records': {
        const deposit = params.depositReceiptId
          ? this.deposits.get(params.depositReceiptId)
          : undefined;
        const payout = params.payoutId
          ? this.payouts.get(params.payoutId)
          : undefined;

        if (!deposit && !payout) {
          throw new Error('Deposit receipt or payout record not found');
        }

        if (deposit && payout) {
          beforeState.payoutWithdrawalId = payout.withdrawalRequestId;
          payout.withdrawalRequestId = deposit.withdrawalRequestId;
          payout.receiptId = deposit.receiptId;
          payout.repaired = true;
          payout.repairNote = params.reason;
          afterState.payoutWithdrawalId = payout.withdrawalRequestId;
          repairedId = `${deposit.receiptId}<->${payout.payoutId}`;
        }
        break;
      }

      case 'override_amount': {
        const payout = params.payoutId
          ? this.payouts.get(params.payoutId)
          : undefined;
        if (!payout) {
          throw new Error(`Payout record ${params.payoutId} not found`);
        }
        if (!params.adjustedAmountMinor) {
          throw new Error(
            'adjustedAmountMinor is required for amount override',
          );
        }
        beforeState.amountMinor = payout.amountMinor.toString();
        payout.amountMinor = BigInt(params.adjustedAmountMinor);
        payout.repaired = true;
        payout.repairNote = params.reason;
        afterState.amountMinor = payout.amountMinor.toString();
        repairedId = payout.payoutId;
        break;
      }

      case 'mark_refunded': {
        const deposit = params.depositReceiptId
          ? this.deposits.get(params.depositReceiptId)
          : undefined;
        if (!deposit) {
          throw new Error(
            `Deposit receipt ${params.depositReceiptId} not found`,
          );
        }
        beforeState.status = deposit.status;
        deposit.status = 'refunded';
        afterState.status = deposit.status;
        repairedId = deposit.receiptId;
        break;
      }

      case 'void_duplicate': {
        if (params.payoutId && this.payouts.has(params.payoutId)) {
          const payout = this.payouts.get(params.payoutId)!;
          beforeState.payoutStatus = payout.payoutStatus;
          payout.payoutStatus = 'cancelled';
          payout.repaired = true;
          payout.repairNote = params.reason;
          afterState.payoutStatus = payout.payoutStatus;
          repairedId = payout.payoutId;
        } else if (
          params.depositReceiptId &&
          this.deposits.has(params.depositReceiptId)
        ) {
          const deposit = this.deposits.get(params.depositReceiptId)!;
          beforeState.status = deposit.status;
          deposit.status = 'refunded';
          afterState.status = deposit.status;
          repairedId = deposit.receiptId;
        } else {
          throw new Error('Record to void not found');
        }
        break;
      }

      default:
        throw new Error(`Unsupported repair action: ${params.action}`);
    }

    // Create immutable audit log entry
    const auditEntry = AuditLogService.recordAction(
      operatorAddress,
      'reconciliation',
      `Reconciliation repair: ${params.action} on ${repairedId}`,
      {
        action: params.action,
        reason: params.reason,
        repairedId,
        beforeState,
        afterState,
      },
      undefined,
      'success',
    );

    return {
      success: true,
      message: `Reconciliation record repaired successfully (${params.action})`,
      repairedRecordId: repairedId,
      auditLogId: auditEntry.id,
    };
  }
}

export const reconciliationStore = new ReconciliationStore();
