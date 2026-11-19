# Status of issues #829–#832

All four issues were checked against `main`. Each is already fixed in the current code, so no code change was needed.

| Issue | Summary | Where it is fixed on `main` |
|---|---|---|
| #829 | `getClaimsByWallet` cursor used `id` alone with a compound `orderBy` | `src/claims/claims.service.ts`: the cursor is a keyset on `(submittedAt DESC, id DESC)`. The cursor row must belong to the same wallet, otherwise `BadRequestException`. |
| #830 | `searchPolicies` always returned `claimsCount: 0` | `src/policy/policy.service.ts`: the raw query selects `claimsCount` with a `count(*)` subquery on `"Claim"`. The fallback path uses `_count`. |
| #831 | `PolicyService` had two `findAll` methods | `src/policy/policy.service.ts`: one `findAll` remains. |
| #832 | `autoProcess` returned `'Rejected'` for `FAILED` outcomes | `src/claims/claims.service.ts`: `ClaimResult` includes `'Failed'`. The product-not-found, non-numeric threshold, and payout-failure paths return `'Failed'`. `'Rejected'` is returned only when the claim is set to `REJECTED`. |

Checked by reading the source on `main`. Tests were not run for this note.

Closes #829
Closes #830
Closes #831
Closes #832
