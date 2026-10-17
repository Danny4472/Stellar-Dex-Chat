import {
  PayoutStatus,
  PayoutActor,
  PayoutTransitionRecord,
  validatePayoutTransition,
} from './payout/payoutLifecycle';

export {
  type PayoutStatus,
  type PayoutActor,
  type PayoutTransitionRecord,
  InvalidPayoutTransitionError,
} from './payout/payoutLifecycle';

type ReplayCacheEntry = {
  seenAt: number;
};

const DEFAULT_REPLAY_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REPLAY_MAX_SIZE = 1000;

const replayCache = new Map<string, ReplayCacheEntry>();

function pruneReplayCache(now = Date.now()) {
  for (const [key, entry] of replayCache.entries()) {
    if (now - entry.seenAt > DEFAULT_REPLAY_TTL_MS) {
      replayCache.delete(key);
    }
  }

  while (replayCache.size > DEFAULT_REPLAY_MAX_SIZE) {
    const oldestKey = replayCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    replayCache.delete(oldestKey);
  }
}

export function isReplayEvent(cacheKey: string): boolean {
  const now = Date.now();
  pruneReplayCache(now);

  if (replayCache.has(cacheKey)) {
    return true;
  }

  replayCache.set(cacheKey, { seenAt: now });
  return false;
}

export function replayCacheStats() {
  return {
    size: replayCache.size,
    ttlMs: DEFAULT_REPLAY_TTL_MS,
    maxSize: DEFAULT_REPLAY_MAX_SIZE,
  };
}

/**
 * In-memory store for transfer status and payout lifecycle tracking.
 */
export interface TransferStatusRecord {
  reference: string;
  status: PayoutStatus;
  amount: number;
  failureReason?: string;
  updatedAt: string;
  clientSessionId?: string;
  providerReference?: string;
  history?: PayoutTransitionRecord[];
}

export interface TransitionPayoutParams {
  reference: string;
  targetStatus: PayoutStatus;
  actor: PayoutActor | string;
  providerReference?: string;
  reason?: string;
  amount?: number;
  clientSessionId?: string;
  failureReason?: string;
  timestamp?: string;
}

// Key is the transfer reference
export const transferStore = new Map<string, TransferStatusRecord>();

export function getTransferStatus(reference: string): TransferStatusRecord | undefined {
  return transferStore.get(reference);
}

/**
 * Centralized state transition function for payout lifecycle.
 * Validates allowed transitions, rejects invalid transitions,
 * keeps terminal states immutable (except success -> reversed),
 * and records transition history (actor, providerReference, timestamp, reason).
 */
export function transitionPayoutStatus({
  reference,
  targetStatus,
  actor,
  providerReference,
  reason,
  amount,
  clientSessionId,
  failureReason,
  timestamp = new Date().toISOString(),
}: TransitionPayoutParams): TransferStatusRecord {
  const existing = transferStore.get(reference);
  const currentStatus: PayoutStatus | 'none' = existing?.status ?? 'none';

  // If already at the target status, treat as idempotent no-op without violating immutability
  if (existing && currentStatus === targetStatus) {
    return existing;
  }

  // Validate allowed transitions
  validatePayoutTransition(currentStatus, targetStatus, reference);

  const transitionRecord: PayoutTransitionRecord = {
    fromStatus: currentStatus,
    toStatus: targetStatus,
    actor,
    providerReference: providerReference ?? existing?.providerReference,
    timestamp,
    reason,
  };

  const history = existing?.history ? [...existing.history] : [];
  history.push(transitionRecord);

  const updatedRecord: TransferStatusRecord = {
    reference,
    status: targetStatus,
    amount: amount ?? existing?.amount ?? 0,
    failureReason: failureReason ?? existing?.failureReason,
    updatedAt: timestamp,
    clientSessionId: clientSessionId ?? existing?.clientSessionId,
    providerReference: providerReference ?? existing?.providerReference,
    history,
  };

  transferStore.set(reference, updatedRecord);
  return updatedRecord;
}

/**
 * Compatibility wrapper that routes through transitionPayoutStatus.
 */
export function setTransferStatus(record: TransferStatusRecord): TransferStatusRecord {
  const existing = transferStore.get(record.reference);
  const currentStatus = existing?.status ?? 'none';

  if (currentStatus !== record.status) {
    return transitionPayoutStatus({
      reference: record.reference,
      targetStatus: record.status,
      actor: 'system',
      providerReference: record.providerReference,
      reason: record.failureReason ?? 'Status update',
      amount: record.amount,
      clientSessionId: record.clientSessionId,
      failureReason: record.failureReason,
      timestamp: record.updatedAt || new Date().toISOString(),
    });
  }

  // Same status update (e.g. metadata only)
  transferStore.set(record.reference, {
    ...existing,
    ...record,
    history: existing?.history ?? record.history,
  });
  return record;
}

export function clearTransferStore(): void {
  transferStore.clear();
  replayCache.clear();
}
