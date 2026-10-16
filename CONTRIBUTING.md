# Contributing

Thanks for your interest in contributing. This document covers the basics for
working in this repository, including how we handle integration credentials.

## Getting started

1. Fork the repository and create a topic branch off `main`.
2. Make your change with focused commits and a clear message.
3. Open a pull request describing the problem and the fix.

## Local setup

Copy the example environment file and fill in your own local values:

```sh
cp .env.example .env
```

Never commit a populated `.env` file. Example files must contain placeholders
only (for example `API_TOKEN=your-token-here`), never real credentials.

## Secret inventory

Every integration credential used by this project is tracked below. This
inventory records metadata only — **never store secret values here**. Values
live in the platform secret store (repository/environment secrets or the
operator's secret manager).

| Secret name | Purpose | Environment | Owner | Rotation cadence | Revocation path |
| --- | --- | --- | --- | --- | --- |
| `API_TOKEN` | Authenticates outbound calls to the integration API | production | platform team | every 90 days | Revoke token in the provider console, then issue a replacement and update the secret store |
| `API_TOKEN` | Same integration, non-production testing | staging | platform team | every 90 days | Revoke token in the provider console, then issue a replacement and update the secret store |
| `WEBHOOK_SECRET` | Verifies inbound webhook signatures | production | platform team | every 180 days | Rotate the signing secret in the provider console and redeploy consumers |
| `DEPLOY_KEY` | Deploys release artifacts | production | release owner | every 180 days | Remove the key from the deploy target and generate a new key pair |

When you add a new integration, add a row here in the same pull request. Keep
the owner and rotation cadence current; an unowned secret is a finding.

## Secret scanning and push protection

Enable the platform's secret scanning and push protection so credentials are
caught before they land:

1. Open **Settings → Code security and analysis** for the repository.
2. Enable **Secret scanning**.
3. Enable **Push protection** so commits containing detected secrets are
   blocked at push time.
4. Enable **Secret scanning alerts** notifications for the security team.

Where the platform does not support these features, run the repository's
security audit workflow on every pull request as the fallback.

## Leak response

If a credential is exposed (committed, logged, or otherwise disclosed):

1. **Contain** — treat the value as compromised. Do not try to scrub history
   first; assume it is already public. Remove the value from the working tree
   and stop any process using it.
2. **Rotate** — revoke the exposed credential using the revocation path in the
   inventory above, then issue a replacement and update the secret store. Rotate
   every credential that shared the exposure.
3. **Verify** — confirm the old credential no longer authenticates, confirm the
   new credential works in each affected environment, and check logs and alerts
   for unauthorized use during the exposure window.
4. **Record** — note the incident, the impacted integrations, and the rotation
   in the security log so the inventory stays accurate.

Run a tabletop exercise of this procedure periodically, and verify that every
integration in the inventory has a working revocation path.

## Logging

Never log secret values. Log placeholders or identifiers instead (for example
`token=***` or a key name), so logs remain useful without leaking credentials.

## Pull request checklist

- [ ] No real secrets, tokens, or credentials are included.
- [ ] Example files and logs use placeholders.
- [ ] New integrations are added to the secret inventory.
- [ ] Tests and checks pass.
