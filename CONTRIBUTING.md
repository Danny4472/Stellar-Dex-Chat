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

## Scoping & Evidence Requirements for Pull Requests

Every PR must scope changes explicitly and include appropriate evidence according to the subsystem touched:

### 1. Smart Contract Changes
- **Compatibility Matrix**: Verification against supported Stellar networks (Standalone, Testnet, Public).
- **Invariants & Testing**: Simulation tests, authorization tests, and boundary checks for integer arithmetic (stroops).
- **Gas & Footprint**: Profiling ledger read/write footprints and storage TTL impact.

### 2. Storage Migration Changes
- **Dry-Run Evidence**: Output log from `migration_dry_run_verifier.sh` demonstrating zero unhandled schema versions.
- **Rollback Plan**: Documented procedure for restoring snapshot state if upgrade fails.

### 3. API & Provider Integration Changes
- **Schema & Conformance**: Verification against OpenAPI contracts and adapter test suites.
- **Idempotency & Fail-Safe**: Evidence that repeated or timed-out requests produce deterministic, duplicate-free outcomes.

### 4. Security & Privacy Changes
- **Threat Model Review**: Analysis of prompt injection vectors, secret redaction, and access controls.
- **Data Minimization**: Verification that PII and sensitive credentials never leak into LLM prompts, URL query strings, or error telemetry.

## Pull Request Checklist

Before opening a PR:

- [ ] Branch name follows the format above
- [ ] Commit messages follow the format above
- [ ] PR description links the issue(s) it closes (`Closes #123`)
- [ ] Required subsystem evidence attached (test logs, dry-run output, threat review)
- [ ] No unrelated files included in the diff

