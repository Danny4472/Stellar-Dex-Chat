import axios, { AxiosError } from 'axios';
import { serverEnv as env } from '@/lib/serverEnv';
import { toMinorUnits } from '../minorUnits';
export { toKobo } from '../minorUnits';

import {
  CreatedRecipient,
  CreateRecipientInput,
  InitiatedTransfer,
  InitiateTransferInput,
  NormalizedPayoutStatus,
  PayoutErrorCode,
  PayoutProvider,
  PayoutProviderError,
  TransferStatus,
  TransferStatusInput,
  VerifiedAccount,
  VerifyAccountInput,
} from './types';

interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 300,
  maxDelayMs: 3000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPaystackSecretKey(): string | undefined {
  return env.PAYSTACK_SECRET_KEY;
}

function paystackHeaders(secretKey: string) {
  return {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
  };
}

function normalizePaystackStatus(status?: string): NormalizedPayoutStatus {
  if (!status) return 'pending';
  const lower = status.toLowerCase();
  switch (lower) {
    case 'success':
      return 'success';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'reversed':
      return 'reversed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
    case 'processing':
    case 'queued':
    case 'otp':
    default:
      return 'pending';
  }
}

function normalizePaystackError(error: unknown): PayoutProviderError {
  if (error instanceof PayoutProviderError) {
    return error;
  }

  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as
      | { message?: string; code?: string }
      | undefined;
    const message = data?.message || error.message || 'Paystack request failed';
    const providerCode = data?.code;

    let code: PayoutErrorCode = 'UNKNOWN_ERROR';
    let retryable = false;

    if (status === 401 || status === 403) {
      code = 'AUTHENTICATION_ERROR';
      retryable = false;
    } else if (status === 404) {
      code = 'ACCOUNT_NOT_FOUND';
      retryable = false;
    } else if (status === 422) {
      code = 'INVALID_ACCOUNT';
      retryable = false;
    } else if (status === 429) {
      code = 'RATE_LIMITED';
      retryable = true;
    } else if (status && status >= 500) {
      code = 'PROVIDER_UNAVAILABLE';
      retryable = true;
    } else if (
      !status ||
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT'
    ) {
      code = 'PROVIDER_UNAVAILABLE';
      retryable = true;
    }

    if (
      message.toLowerCase().includes('balance') ||
      message.toLowerCase().includes('insufficient')
    ) {
      code = 'INSUFFICIENT_FUNDS';
      retryable = false;
    }

    return new PayoutProviderError({
      message,
      code,
      statusCode: status,
      retryable,
      providerCode,
      rawResponse: error.response?.data,
    });
  }

  const message =
    error instanceof Error ? error.message : 'Unknown provider error';
  return new PayoutProviderError({
    message,
    code: 'UNKNOWN_ERROR',
    retryable: false,
  });
}

/**
 * Executes an HTTP operation with adapter-internal retry policy for transient errors.
 */
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err: unknown) {
      const normalized = normalizePaystackError(err);
      if (!normalized.retryable || attempt >= policy.maxRetries) {
        throw normalized;
      }

      attempt += 1;
      const delay = Math.min(
        policy.initialDelayMs * 2 ** (attempt - 1),
        policy.maxDelayMs,
      );
      await sleep(delay);
    }
  }
}

// In-memory idempotency cache for transfer initiation inside the adapter
const adapterIdempotencyCache = new Map<string, InitiatedTransfer>();

export const paystackProvider: PayoutProvider = {
  name: 'paystack',

  async verifyAccount(input: VerifyAccountInput): Promise<VerifiedAccount> {
    const { accountNumber, bankCode } = input;
    const secretKey = getPaystackSecretKey();

    if (!secretKey) {
      console.warn('Paystack secret key not found, using mock verification');
      return {
        accountNumber,
        accountName: 'John Doe',
        bankCode,
        bankId: Number.parseInt(bankCode, 10) || 1,
        rawResponse: { mock: true },
      };
    }

    return executeWithRetry(async () => {
      const response = await axios.get('https://api.paystack.co/bank/resolve', {
        headers: paystackHeaders(secretKey),
        params: { account_number: accountNumber, bank_code: bankCode },
        timeout: 10000,
      });

      if (response.data?.status && response.data?.data) {
        return {
          accountNumber: response.data.data.account_number,
          accountName: response.data.data.account_name,
          bankCode,
          bankId: response.data.data.bank_id ?? Number.parseInt(bankCode, 10),
          rawResponse: response.data.data,
        };
      }

      throw new PayoutProviderError({
        message: response.data?.message || 'Account verification failed',
        code: 'INVALID_ACCOUNT',
        statusCode: 422,
      });
    });
  },

  async createRecipient(
    input: CreateRecipientInput,
  ): Promise<CreatedRecipient> {
    const secretKey = getPaystackSecretKey();
    const currency = input.currency || 'NGN';

    if (!secretKey) {
      console.warn(
        'Paystack secret key not found, using mock recipient creation',
      );
      return {
        recipientCode: `RCP_${Math.random().toString(36).substring(2, 11)}`,
        name: input.name,
        accountNumber: input.account_number,
        bankCode: input.bank_code,
        currency,
        type: input.type,
        provider: 'paystack',
        rawResponse: { mock: true },
      };
    }

    return executeWithRetry(async () => {
      const response = await axios.post(
        'https://api.paystack.co/transferrecipient',
        {
          type: input.type,
          name: input.name,
          account_number: input.account_number,
          bank_code: input.bank_code,
          currency,
        },
        {
          headers: paystackHeaders(secretKey),
          timeout: 10000,
        },
      );

      if (response.data?.status && response.data?.data) {
        const d = response.data.data;
        return {
          recipientCode: d.recipient_code,
          name: d.name || input.name,
          accountNumber: d.details?.account_number || input.account_number,
          bankCode: d.details?.bank_code || input.bank_code,
          currency: d.currency || currency,
          type: d.type || input.type,
          provider: 'paystack',
          rawResponse: d,
        };
      }

      throw new PayoutProviderError({
        message: response.data?.message || 'Failed to create recipient',
        code: 'INVALID_REQUEST',
        statusCode: 400,
      });
    });
  },

  async initiateTransfer(
    input: InitiateTransferInput,
  ): Promise<InitiatedTransfer> {
    const currency = input.currency || 'NGN';
    const amountMinor = toMinorUnits(input.amount, currency);
    const reference =
      input.reference ||
      input.idempotencyKey ||
      `tx_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Adapter-internal idempotency check
    if (adapterIdempotencyCache.has(reference)) {
      return adapterIdempotencyCache.get(reference)!;
    }

    const secretKey = getPaystackSecretKey();

    if (!secretKey) {
      console.warn(
        'Paystack secret key not found, using mock transfer initiation',
      );
      const mockResult: InitiatedTransfer = {
        reference,
        status: 'pending',
        providerReference: `PROV_${reference}`,
        transferCode: `TRF_${Math.random().toString(36).substring(2, 9)}`,
        amountMinor,
        currency,
        recipientCode: input.recipient,
        rawResponse: { mock: true },
      };
      adapterIdempotencyCache.set(reference, mockResult);
      return mockResult;
    }

    return executeWithRetry(async () => {
      const transferData = {
        source: input.source,
        amount: Number(amountMinor), // Paystack requires amount in kobo/minor units as number
        recipient: input.recipient,
        reason: input.reason || 'Crypto withdrawal',
        reference,
      };

      const response = await axios.post(
        'https://api.paystack.co/transfer',
        transferData,
        {
          headers: paystackHeaders(secretKey),
          timeout: 15000,
        },
      );

      if (response.data?.status && response.data?.data) {
        const d = response.data.data;
        const result: InitiatedTransfer = {
          reference: d.reference || reference,
          status: normalizePaystackStatus(d.status),
          providerReference: d.transfer_code || d.reference,
          transferCode: d.transfer_code,
          amountMinor,
          currency,
          recipientCode: input.recipient,
          rawResponse: d,
        };
        adapterIdempotencyCache.set(reference, result);
        return result;
      }

      throw new PayoutProviderError({
        message: response.data?.message || 'Failed to initiate transfer',
        code: 'INVALID_REQUEST',
        statusCode: 400,
      });
    });
  },

  async checkTransferStatus(
    input: TransferStatusInput,
  ): Promise<TransferStatus> {
    const { reference } = input;
    const secretKey = getPaystackSecretKey();

    if (!secretKey) {
      console.warn('Paystack secret key not found, using mock transfer status');
      return {
        reference,
        status: 'pending',
        providerReference: `PROV_${reference}`,
        rawResponse: { mock: true },
      };
    }

    return executeWithRetry(async () => {
      const response = await axios.get(
        `https://api.paystack.co/transfer/verify/${encodeURIComponent(reference)}`,
        {
          headers: paystackHeaders(secretKey),
          timeout: 10000,
        },
      );

      if (response.data?.status && response.data?.data) {
        const d = response.data.data;
        return {
          reference: d.reference || reference,
          status: normalizePaystackStatus(d.status),
          providerReference: d.transfer_code || d.reference,
          transferCode: d.transfer_code,
          amountMinor: d.amount ? BigInt(d.amount) : undefined,
          currency: d.currency || 'NGN',
          failureReason: d.failures?.reason || d.gateway_response || undefined,
          completedAt: d.transferred_at || d.updated_at || undefined,
          rawResponse: d,
        };
      }

      throw new PayoutProviderError({
        message: response.data?.message || 'Failed to fetch transfer status',
        code: 'ACCOUNT_NOT_FOUND',
        statusCode: 404,
      });
    });
  },
};
