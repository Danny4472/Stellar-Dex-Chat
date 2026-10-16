#!/usr/bin/env tsx
/**
 * Validates that .env.example contains all variables declared in src/lib/env.ts
 * and does not list variables that are not read by the application.
 *
 * Usage:
 *   pnpm exec tsx scripts/validate-env-example.ts
 *
 * Exit codes:
 *   0 - All variables match
 *   1 - Missing variables or extra variables found
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ENV_EXAMPLE_PATH = join(__dirname, '../.env.example');
const ENV_TS_PATH = join(__dirname, '../src/lib/env.ts');

/**
 * Extract variable names from env.ts schema definitions
 */
function extractEnvTsVariables(): Set<string> {
  const envTsContent = readFileSync(ENV_TS_PATH, 'utf-8');
  const variables = new Set<string>();

  // Match lines like: VARIABLE_NAME: z.string()...
  const schemaPattern = /^\s*([A-Z_][A-Z0-9_]*)\s*:/gm;
  let match;

  while ((match = schemaPattern.exec(envTsContent)) !== null) {
    variables.add(match[1]);
  }

  return variables;
}

/**
 * Extract non-comment variable names from .env.example
 */
function extractEnvExampleVariables(): Set<string> {
  const envExampleContent = readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
  const variables = new Set<string>();

  const lines = envExampleContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed === '') {
      continue;
    }

    // Extract variable name from KEY=value or # KEY=value
    const match = trimmed.match(/^#?\s*([A-Z_][A-Z0-9_]*)=/);
    if (match) {
      variables.add(match[1]);
    }
  }

  return variables;
}

/**
 * Observability alerting thresholds for issue #121.
 *
 * These thresholds drive warning/critical alerts for aging withdrawals and
 * payout reconciliation backlog. They are validated here so that operators
 * cannot silently ship a misconfigured alerting surface (e.g. critical below
 * warning, or a zero/negative age that would flap on every tick).
 *
 * Each threshold is paired with a concrete operator action and a safe record
 * reference (an id/type, never PII or secrets) so alerts are actionable.
 */
interface AlertThreshold {
  /** Stable key used for deduplication of flapping alerts. */
  key: string;
  /** Warning threshold value (inclusive). */
  warning: number;
  /** Critical threshold value (inclusive); must be >= warning. */
  critical: number;
  /** Unit of the threshold, for operator context. */
  unit: 'seconds' | 'count';
  /** Concrete operator action to take when the alert fires. */
  operatorAction: string;
  /** Safe, non-sensitive record reference template. */
  recordRef: string;
  /**
   * Whether the condition is an expected user approval delay rather than a
   * genuine provider failure. Expected delays are classified separately so
   * they do not page on-call for normal user behavior.
   */
  expectedUserDelay: boolean;
}

const ALERT_THRESHOLDS: AlertThreshold[] = [
  {
    key: 'withdrawal.queue.age',
    warning: 15 * 60,
    critical: 60 * 60,
    unit: 'seconds',
    operatorAction: 'Inspect withdrawal queue and retry stuck payouts.',
    recordRef: 'withdrawal:{withdrawalId}',
    expectedUserDelay: false,
  },
  {
    key: 'withdrawal.queue.depth',
    warning: 50,
    critical: 200,
    unit: 'count',
    operatorAction: 'Scale payout workers or drain the withdrawal queue.',
    recordRef: 'withdrawal:{withdrawalId}',
    expectedUserDelay: false,
  },
  {
    key: 'indexer.lag',
    warning: 60,
    critical: 300,
    unit: 'seconds',
    operatorAction: 'Check indexer health and re-sync from last safe block.',
    recordRef: 'indexer:{chainId}:{blockNumber}',
    expectedUserDelay: false,
  },
  {
    key: 'webhook.backlog',
    warning: 100,
    critical: 1000,
    unit: 'count',
    operatorAction: 'Drain webhook backlog and verify provider delivery.',
    recordRef: 'webhook:{webhookId}',
    expectedUserDelay: false,
  },
  {
    key: 'reconciliation.age',
    warning: 30 * 60,
    critical: 2 * 60 * 60,
    unit: 'seconds',
    operatorAction: 'Run payout reconciliation and resolve unmatched records.',
    recordRef: 'reconciliation:{reconciliationId}',
    expectedUserDelay: false,
  },
  {
    key: 'withdrawal.awaiting_user_approval',
    warning: 24 * 60 * 60,
    critical: 7 * 24 * 60 * 60,
    unit: 'seconds',
    operatorAction: 'Notify user; do not page on-call for expected approval delay.',
    recordRef: 'withdrawal:{withdrawalId}',
    expectedUserDelay: true,
  },
];

/**
 * Validate alerting thresholds: warning <= critical, positive values, unique
 * dedup keys, and safe record references (no secrets/PII placeholders).
 */
function validateAlertThresholds(): boolean {
  let isValid = true;
  const seenKeys = new Set<string>();

  for (const t of ALERT_THRESHOLDS) {
    if (seenKeys.has(t.key)) {
      console.error(`❌ ERROR: Duplicate alert dedup key: ${t.key}`);
      isValid = false;
    }
    seenKeys.add(t.key);

    if (t.warning <= 0 || t.critical <= 0) {
      console.error(`❌ ERROR: Alert ${t.key} has non-positive threshold`);
      isValid = false;
    }

    if (t.critical < t.warning) {
      console.error(
        `❌ ERROR: Alert ${t.key} critical (${t.critical}) < warning (${t.warning})`,
      );
      isValid = false;
    }

    if (!t.operatorAction || !t.recordRef) {
      console.error(`❌ ERROR: Alert ${t.key} missing operator action or record ref`);
      isValid = false;
    }

    // Safe record references must be templated ids, never raw secrets/PII.
    if (/secret|token|password|email|address/i.test(t.recordRef)) {
      console.error(`❌ ERROR: Alert ${t.key} record ref may leak sensitive data`);
      isValid = false;
    }
  }

  if (isValid) {
    console.log(`✅ SUCCESS: ${ALERT_THRESHOLDS.length} alert thresholds validated`);
  }

  return isValid;
}

/**
 * Main validation logic
 */
function validateEnvExample(): boolean {
  const schemaVars = extractEnvTsVariables();
  const exampleVars = extractEnvExampleVariables();

  // Find variables in schema but not in .env.example
  const missingInExample = [...schemaVars].filter(v => !exampleVars.has(v));

  // Find variables in .env.example but not in schema
  const extraInExample = [...exampleVars].filter(v => !schemaVars.has(v));

  let isValid = true;

  if (missingInExample.length > 0) {
    console.error('❌ ERROR: Variables declared in env.ts but missing from .env.example:');
    missingInExample.forEach(v => console.error(`  - ${v}`));
    isValid = false;
  }

  if (extraInExample.length > 0) {
    console.error('❌ ERROR: Variables in .env.example that are not read by env.ts:');
    extraInExample.forEach(v => console.error(`  - ${v}`));
    isValid = false;
  }

  if (isValid) {
    console.log('✅ SUCCESS: .env.example matches env.ts schema');
    console.log(`   Found ${schemaVars.size} variables`);
  }

  return isValid;
}

// Run validation
const envValid = validateEnvExample();
const alertsValid = validateAlertThresholds();
process.exit(envValid && alertsValid ? 0 : 1);
