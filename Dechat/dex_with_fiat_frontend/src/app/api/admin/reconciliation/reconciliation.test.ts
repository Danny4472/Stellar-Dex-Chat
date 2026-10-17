import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockEnv = { ADMIN_SECRET: 'test-admin-secret' };
vi.mock('@/lib/serverEnv', () => ({
  get serverEnv() {
    return mockEnv;
  },
}));

import { GET, POST } from './route';
import {
  reconciliationStore,
  reconcileRecords,
  createLinkageKey,
  EscrowDepositReceipt,
  OffChainPayoutRecord,
} from '@/lib/payout/reconciliation';
import AuditLogService from '@/lib/auditLog';

describe('Admin Reconciliation Lifecycle & Repair (Issue #39)', () => {
  beforeEach(() => {
    mockEnv.ADMIN_SECRET = 'test-admin-secret';
    reconciliationStore.reset();
  });

  describe('Authentication', () => {
    it('returns 401 when no authentication is provided', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation');
      const res = await GET(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/Unauthorized/i);
    });

    it('returns 401 when invalid token is provided in x-admin-token', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'wrong-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(401);
    });

    it('returns 200 when valid token is provided in x-admin-token', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 200 when valid bearer token is provided', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { authorization: 'Bearer test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
    });
  });

  describe('Deterministic Fixtures: Matching & Mismatch Classes', () => {
    it('generates a stable linkage key across receipt, request, payout, and provider reference', () => {
      const key1 = createLinkageKey({
        receiptId: 'rcpt_100',
        withdrawalRequestId: 'wr_100',
        payoutId: 'pay_100',
        providerReference: 'PROV_100',
      });
      expect(key1).toBe('wr_100');

      const key2 = createLinkageKey({
        receiptId: 'rcpt_200',
        providerReference: 'PROV_200',
      });
      expect(key2).toBe('rcpt_200:PROV_200');
    });

    it('correctly classifies matched, unmatched, duplicated, and amount-mismatched records', () => {
      const deposits: EscrowDepositReceipt[] = [
        // 1. Perfectly matched deposit
        {
          receiptId: 'rcpt_match_1',
          withdrawalRequestId: 'wr_match_1',
          txHash: '0xhash1',
          amountMinor: 500000n, // 5000.00 NGN
          currency: 'NGN',
          wallet: 'GA_WALLET_1',
          timestamp: '2026-03-20T10:00:00Z',
          status: 'deposited',
        },
        // 2. Unmatched deposit (crypto deposited, no fiat payout)
        {
          receiptId: 'rcpt_unmatched_dep',
          withdrawalRequestId: 'wr_unmatched_dep',
          txHash: '0xhash2',
          amountMinor: 100000n,
          currency: 'NGN',
          wallet: 'GA_WALLET_2',
          timestamp: '2026-03-21T10:00:00Z',
          status: 'deposited',
        },
        // 3. Amount mismatched deposit
        {
          receiptId: 'rcpt_diff_1',
          withdrawalRequestId: 'wr_diff_1',
          txHash: '0xhash3',
          amountMinor: 750000n, // 7500.00 NGN
          currency: 'NGN',
          wallet: 'GA_WALLET_3',
          timestamp: '2026-03-22T10:00:00Z',
          status: 'deposited',
        },
        // 4. Duplicate deposits sharing the same withdrawal request
        {
          receiptId: 'rcpt_dup_1',
          withdrawalRequestId: 'wr_dup_1',
          txHash: '0xhash4a',
          amountMinor: 200000n,
          currency: 'NGN',
          wallet: 'GA_WALLET_4',
          timestamp: '2026-03-23T10:00:00Z',
          status: 'deposited',
        },
        {
          receiptId: 'rcpt_dup_2',
          withdrawalRequestId: 'wr_dup_1',
          txHash: '0xhash4b',
          amountMinor: 200000n,
          currency: 'NGN',
          wallet: 'GA_WALLET_4',
          timestamp: '2026-03-23T10:05:00Z',
          status: 'deposited',
        },
      ];

      const payouts: OffChainPayoutRecord[] = [
        // 1. Matching payout
        {
          payoutId: 'pay_match_1',
          withdrawalRequestId: 'wr_match_1',
          providerReference: 'PROV_match_1',
          amountMinor: 500000n,
          currency: 'NGN',
          recipient: 'John Doe',
          payoutStatus: 'completed',
          payoutDate: '2026-03-20T10:30:00Z',
        },
        // 3. Amount mismatched payout (paid 7000.00 instead of 7500.00)
        {
          payoutId: 'pay_diff_1',
          withdrawalRequestId: 'wr_diff_1',
          providerReference: 'PROV_diff_1',
          amountMinor: 700000n,
          currency: 'NGN',
          recipient: 'Bob Smith',
          payoutStatus: 'completed',
          payoutDate: '2026-03-22T10:30:00Z',
        },
        // 5. Unmatched payout (fiat sent without crypto deposit receipt)
        {
          payoutId: 'pay_unmatched_fiat',
          withdrawalRequestId: 'wr_unmatched_fiat',
          providerReference: 'PROV_unmatched_fiat',
          amountMinor: 300000n,
          currency: 'NGN',
          recipient: 'Alice Brown',
          payoutStatus: 'completed',
          payoutDate: '2026-03-24T10:00:00Z',
        },
      ];

      const report = reconcileRecords(deposits, payouts);

      // Verify matched
      expect(report.matched.length).toBe(1);
      expect(report.matched[0].linkageKey).toBe('wr_match_1');
      expect(report.matched[0].amountMinor).toBe('500000');

      // Verify unmatched deposit
      expect(report.unmatched.depositsWithoutPayout.length).toBe(1);
      expect(report.unmatched.depositsWithoutPayout[0].receiptId).toBe(
        'rcpt_unmatched_dep',
      );

      // Verify unmatched payout
      expect(report.unmatched.payoutsWithoutDeposit.length).toBe(1);
      expect(report.unmatched.payoutsWithoutDeposit[0].payoutId).toBe(
        'pay_unmatched_fiat',
      );

      // Verify amount mismatch
      expect(report.amountMismatched.length).toBe(1);
      expect(report.amountMismatched[0].linkageKey).toBe('wr_diff_1');
      expect(report.amountMismatched[0].depositAmountMinor).toBe('750000');
      expect(report.amountMismatched[0].payoutAmountMinor).toBe('700000');
      expect(report.amountMismatched[0].differenceMinor).toBe('50000');

      // Verify duplicates
      expect(report.duplicated.length).toBe(1);
      expect(report.duplicated[0].linkageKey).toBe('wr_dup_1');
      expect(report.duplicated[0].deposits.length).toBe(2);
    });

    it('keeps reconciliation read-only by default on GET', async () => {
      const req = new NextRequest(
        'http://localhost/api/admin/reconciliation?format=report',
        {
          headers: { 'x-admin-token': 'test-admin-secret' },
        },
      );

      const res1 = await GET(req);
      const report1 = await res1.json();

      const res2 = await GET(req);
      const report2 = await res2.json();

      expect(report1.summary).toEqual(report2.summary);
      expect(report1.matched.length).toEqual(report2.matched.length);
      expect(report1.unmatched).toEqual(report2.unmatched);
    });
  });

  describe('Audited Repair Action (POST /api/admin/reconciliation)', () => {
    it('rejects repair actions without admin authentication', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        method: 'POST',
        body: JSON.stringify({
          action: 'override_amount',
          withdrawalRequestId: 'wr_mismatch_003',
          payoutId: 'TRF_345678',
          reason: 'Adjusted payout after manual bank verification',
          adjustedAmountMinor: '7500',
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it('rejects repair action without a valid reason', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        method: 'POST',
        headers: {
          'x-admin-token': 'test-admin-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'override_amount',
          withdrawalRequestId: 'wr_mismatch_003',
          payoutId: 'TRF_345678',
          reason: '',
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('reason');
    });

    it('executes audited repair action and records audit log entry', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        method: 'POST',
        headers: {
          'x-admin-token': 'test-admin-secret',
          'x-admin-address': 'G_OPERATOR_AUDITOR_1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'override_amount',
          withdrawalRequestId: 'wr_mismatch_003',
          payoutId: 'TRF_345678',
          reason: 'Adjusted payout after confirming fee deduction with bank',
          adjustedAmountMinor: '7500',
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.auditLogId).toBeDefined();

      // Verify the repair adjusted the record in reconciliation
      const getReq = new NextRequest(
        'http://localhost/api/admin/reconciliation?format=report',
        {
          headers: { 'x-admin-token': 'test-admin-secret' },
        },
      );
      const reportRes = await GET(getReq);
      const report = await reportRes.json();

      // wr_mismatch_003 should now be matched (both 7500)
      const matched = report.matched.find(
        (m: { linkageKey: string }) => m.linkageKey === 'wr_mismatch_003',
      );
      expect(matched).toBeDefined();
    });
  });
});
