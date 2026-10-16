# Contributing

## Branch Naming

Branches follow this pattern:
<your-username>/<type>/<short-description>

`<type>` is one of:

- `feat/` — new feature
- `fix/` — bug fix
- `chore/` — maintenance, tooling, dependencies
- `docs/` — documentation only
- `refactor/` — code change that isn't a fix or a feature
- `test/` — adding or fixing tests

If your branch addresses one or more issues, include the issue number(s) in the description:
feat/issues-986-987-988-frontend-accessibility

fix/issue-966-fee-calculation-overflow

## Commit Message Format

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
<type>(<scope>): <description>

`<type>` must be one of:

- `feat` — new feature
- `fix` — bug fix
- `docs` — documentation only
- `style` — formatting, no code meaning change
- `refactor` — code change that isn't a fix or a feature
- `perf` — performance improvement
- `test` — adding or fixing tests
- `build` — build system or dependencies
- `ci` — CI configuration
- `chore` — anything else maintenance-related
- `security` — security fix

`<scope>` is optional and usually the area touched, e.g. `frontend`, `contract`.

Reference issue numbers in the description when relevant:
feat(frontend): add CSV export button to AuditTable

fix(contract): integer overflow in fee calculation for large deposits #966

docs: add CONTRIBUTING.md with branch and commit conventions

A breaking change is marked with `!` after the type/scope:
feat(contract)!: change withdrawal function signature

## Pull Request Checklist

Before opening a PR:

- [ ] Branch name follows the format above
- [ ] Commit messages follow the format above
- [ ] PR description links the issue(s) it closes (`Closes #123`)
- [ ] `npx lint-staged` runs clean (this also runs automatically on commit)
- [ ] Tests pass locally
- [ ] No unrelated files included in the diff

## Backup & Disaster Recovery for Payout State

Changes that touch payout intents, idempotency records, or audit history must keep the
backup/DR guarantees below intact. See the payout DR runbook for the full procedure.

### Recovery objectives

| Data set | RPO | RTO |
| --- | --- | --- |
| Payout intents (in-flight and settled) | 5 minutes | 1 hour |
| Idempotency records | 0 (synchronous, replicated) | 1 hour |
| Audit history | 5 minutes | 4 hours |

Idempotency records must never be lost: a restore that drops them risks replaying transfers.

### Backup ownership, retention, and access

- Backups are encrypted at rest and in transit; keys are held by the on-call platform owner
  and rotated on the standard key-rotation schedule.
- Retention: 35 days of point-in-time recovery plus monthly full snapshots for 12 months.
- Restore permissions are limited to the on-call platform owner and a designated backup
  approver; restores require a second reviewer.
- Dependencies: managed database snapshots, the key management service, and the audit log
  archive. A restore is not complete until all three are verified.

### Reconciliation before writes resume

After restoring into isolation, reconcile before re-enabling writes:

1. Compare restored payout intents against authoritative provider records and on-chain state.
2. Verify audit history is continuous with no gaps across the restore boundary.
3. Confirm idempotency records are present so no transfer can be replayed.
4. Reconcile in-flight transfers and resolve any mismatch before writes resume.

### Drills and remediation

- Run a restore drill quarterly, and after any change to the backup pipeline.
- Each drill restores into isolation and verifies counts, audit continuity, idempotency, and
  in-flight transfer reconciliation.
- File remediation items as issues, assign an owner, and track them to closure before the next drill.
