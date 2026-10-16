# AdminGuard test coverage

The AdminGuard authorization boundary is covered by
`src/components/__tests__/AdminGuard.test.tsx`.

The suite verifies the protected-content behavior for an allowed administrator,
an unauthenticated visitor, a malformed address, and a non-admin address. Run
the focused suite with:

```bash
npm run test -- src/components/__tests__/AdminGuard.test.tsx
```

This document records the coverage requested in issue #595 and gives
maintainers a direct CI-equivalent command for reviewing it.

## Payout authorization regression matrix (issue #117)

Payout routes must enforce ownership and admin requirements so they cannot be
bypassed during route changes. The regression matrix below is required for every
payout route and must be extended whenever a new payout route is added.

### Route-by-role cases

For each payout route, cover all four roles:

| Role | Expectation |
| --- | --- |
| Anonymous | Denied (401/redirect to auth) |
| Unrelated user | Denied (403) |
| Owner | Allowed for own record only |
| Admin | Allowed |

### Alternate identifiers, cursors, and exports

- Exercise alternate identifiers (e.g. payout id vs. user id vs. address) to
  confirm the route resolves ownership from the authenticated principal, not
  from a client-supplied identifier.
- Exercise pagination cursors to confirm a cursor cannot be used to read another
  user's records.
- Exercise export endpoints to confirm exports are scoped to the caller (or
  admin) and never include another user's records.

### Denied-call invariants

Denied calls must:

- not mutate state (no writes, no status transitions),
- not call providers (assert with provider spies), and
- not reveal another user's record (no data leakage in body, headers, or errors).

### New payout routes

Any new payout route must ship with corresponding authorization test cases in
this matrix before it can be merged.

### Validation

Run the full matrix with provider spies enabled and verify that every denied
call produces no external effects.
