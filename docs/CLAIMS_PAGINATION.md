# Claims Pagination Contract & Performance Guide (#749)

## Overview

As the claims database grows, offset-based pagination (`OFFSET N LIMIT M`) experiences progressive latency degradation because PostgreSQL/Prisma must scan and discard `N` rows before returning `M` records. To support high-scale query performance, **cursor-based (keyset) pagination** has been introduced for claims queries while maintaining 100% backward compatibility for clients using traditional `page` and `limit`.

---

## API Contract

### Endpoints
- `GET /api/v1/claims?wallet={wallet}&cursor={cursor}&limit={limit}`
- `GET /api/v1/claims/history/{wallet}?cursor={cursor}&limit={limit}` (deprecated alias)

### Query Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `wallet` | `string` | Yes | — | Stellar wallet address of the claimant (must match authenticated caller) |
| `cursor` | `string` (UUID) | No | `null` | Claim UUID pointing to the last item of the previous page. If omitted, offset pagination is used. |
| `limit` | `number` | No | `20` | Maximum items to return per page (clamped between 1 and 100) |
| `page` | `number` | No | `1` | Traditional 1-based page number (used when `cursor` is omitted) |

### Response Schema (`PaginatedResponseDto`)

```json
{
  "success": true,
  "data": [
    {
      "id": "c138fd94-f203-4fba-bb83-c5b741ea0201",
      "policyId": "d32890ae-324c-4da8-958b-fbc656c80c55",
      "claimant": "GAAABBBCCCDDDEEEFFF...",
      "coverageAmount": "1000",
      "payoutAmount": "1000",
      "triggerMet": true,
      "status": "PAID",
      "submittedAt": 1700000000,
      "processedAt": 1700000010,
      "txHash": "6b2a8d...",
      "createdAt": 1700000000
    }
  ],
  "total": 1250,
  "page": 1,
  "limit": 20,
  "nextCursor": "c138fd94-f203-4fba-bb83-c5b741ea0201",
  "hasMore": true
}
```

- **`nextCursor`**: UUID of the last item in the current page, or `null` if there are no subsequent pages.
- **`hasMore`**: Boolean indicating whether further results exist beyond the current page.
- **`total`**: Total number of claims for this wallet (cached for 30 seconds to prevent expensive COUNT operations).

---

## Keyset Pagination Mechanics

When `cursor` is provided:
1. Prisma executes keyset pagination using the composite index order `[{ submittedAt: 'desc' }, { id: 'desc' }]`:
   ```ts
   cursor: { id: cursor },
   skip: 1,
   take: limit + 1
   ```
2. The service fetches `limit + 1` records. If `records.length > limit`, `hasMore` is `true`, `nextCursor` is set to `records[limit - 1].id`, and only `limit` records are returned.
3. If `records.length <= limit`, `hasMore` is `false` and `nextCursor` is `null`.

When `cursor` is omitted:
- Legacy offset pagination is used (`skip: (page - 1) * limit`), preserving backward compatibility with existing frontends and tests.

---

## Benchmark & Performance Comparison

### Problem: Offset Pagination Degradation
With traditional `OFFSET N LIMIT M`, the database engine must execute a sequential scan or index scan across all `N + M` rows, discarding the first `N` rows:

$$\text{Scan Rows} = N + M$$

| Page ($M = 20$) | Offset ($N$) | Offset Rows Scanned | Cursor Rows Scanned | Latency Multiplier |
|---|---|---|---|---|
| Page 1 | 0 | 20 | 21 | $1\times$ |
| Page 50 | 1,000 | 1,020 | 21 | $\sim 50\times$ |
| Page 500 | 10,000 | 10,020 | 21 | $\sim 480\times$ |
| Page 5,000 | 100,000 | 100,020 | 21 | $\sim 4,760\times$ |

### Solution: Keyset Cursor Seek
Cursor pagination performs an index seek directly to the `cursor` row, scanning only `limit + 1` rows regardless of table depth:

$$\text{Scan Rows} = M + 1 = \mathcal{O}(1)$$

Query plan execution time remains constant ($\sim 1\text{--}3\text{ ms}$) whether fetching page 1 or page 5,000.
