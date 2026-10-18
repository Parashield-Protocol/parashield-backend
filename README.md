# parashield-backend

NestJS API server for Parashield — a decentralized parametric insurance protocol on Stellar Soroban.

Two responsibilities: serve the REST API consumed by the frontend, and run the keeper daemon that submits oracle data and triggers claims automatically.

---

## Architecture

ParaShield backend is built around four modules:

| Module | Role |
|--------|------|
| **Policy Engine** (`src/policy/`) | Product catalog, policy purchase, premium calculation, coverage validation |
| **Claims Processor** (`src/claims/`) | Manual and automatic claim submission, duplicate claim prevention, claim history |
| **Oracle Worker** (`src/oracle/`) | Fetches real-world data (rainfall, temperature, flight delays) from external APIs and persists to DB |
| **Stellar Bridge** (`src/stellar/`) | Builds, simulates, and submits Soroban transactions. Manages the keeper keypair |

Supporting infrastructure:
- **PrismaService** — PostgreSQL integration for policy and oracle data storage
- **AuthModule** — Stellar wallet signature verification + JWT issuance
- **LoggingInterceptor** — Request/response duration logging
- **ThrottleGuard** — IP-based rate limiting (60 req/min)
- **Vault bootstrap** — optional HashiCorp Vault KV loading before Nest validates env vars
- **OpenTelemetry** — optional distributed tracing when OTEL packages are installed/configured

---

## Authentication

ParaShield supports two authentication schemes:

- **JWT bearer auth**: the primary frontend flow. Clients request `/api/v1/auth/challenge`, sign the nonce, call `/api/v1/auth/login`, then send `Authorization: Bearer <token>`. `JwtAuthGuard` verifies the token and sets `req.wallet` from the token payload.
  - `JWT_SECRET` is strictly required and validated at startup: it must be at least 32 characters long. Insecure fallbacks and placeholder values (e.g. previous dev defaults, "changeme", "secret") are rejected.
  - **Security Notice**: Any environment previously running on the default secret must configure a cryptographically random secret before deploying. Any tokens signed with the legacy default secret should be treated as compromised.
- **Wallet-header auth**: a legacy request-signature flow for protected API routes. Clients send `x-wallet-address`, `x-wallet-message`, and `x-wallet-signature`; `AuthMiddleware` verifies the Stellar signature and sets `req.wallet`.

Operator-only oracle fetch endpoints require either `x-api-key: <ORACLE_OPERATOR_API_KEY>` or an admin JWT. Public endpoints such as `/api/v1/products`, `/api/v1/oracle/latest/:key`, `/api/v1/health`, and `/docs` do not run wallet-header middleware.

Admin product management (`POST`/`PATCH`/`DELETE /api/v1/admin/products`) is authenticated by `OperatorAuthGuard` and then authorized by `AdminRoleGuard`: it accepts an admin JWT (`role: admin`), `ADMIN_API_KEY`, or — only when `ADMIN_API_KEY` is unset — `ORACLE_OPERATOR_API_KEY`. Configuring both keys keeps oracle-feed automation out of product management.

### API key rotation

Operator/admin API keys can be rotated without downtime:

1. Set the new key on `ORACLE_OPERATOR_API_KEY` (or `ADMIN_API_KEY`) and move the outgoing key to `ORACLE_OPERATOR_API_KEY_PREVIOUS` (or `ADMIN_API_KEY_PREVIOUS`), then restart.
2. Both keys authenticate during the grace window — requests using the old key are logged as warnings.
3. Once all clients have migrated, remove the `*_PREVIOUS` variables.

The overlap is bounded by `API_KEY_ROTATION_GRACE_MINUTES` (default 1440 = 24 hours, measured from process start). Setting it to `0` disables previous keys immediately.

---

## API Endpoints

All endpoints are prefixed with `/api/v1`. Swagger docs available at `/docs`.

### Policy

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/v1/products` | List all active insurance products |
| `GET` | `/api/v1/policies/me?wallet=<address>` | Get policies for a wallet address |
| `GET` | `/api/v1/policies/:id` | Get a single policy by UUID |
| `PATCH` | `/api/v1/policies/:id` | Update a policy (e.g. change oracleKey, emits status change event) |
| `POST` | `/api/v1/policies/:id/cancel` | Cancel an active policy |
| `POST` | `/api/v1/policies/buy` | Calculate premium and get a purchase quote |

### Claims

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/v1/claims/submit` | Submit a manual claim |
| `POST` | `/api/v1/claims/:policyId/auto` | Trigger automatic claim evaluation (keeper only) |
| `GET` | `/api/v1/claims/:id` | Get claim details by ID |
| `GET` | `/api/v1/claims/history/:wallet` | Deprecated: use `GET /api/v1/claims?wallet=...` |

### Oracle

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/v1/oracle/latest/:key` | Get the latest reading for an oracle key |
| `POST` | `/api/v1/oracle/fetch/rainfall` | Operator-only: fetch rainfall data from Open-Meteo |
| `POST` | `/api/v1/oracle/fetch/temperature` | Operator-only: fetch temperature data from Open-Meteo |
| `GET` | `/api/v1/oracle/rainfall` | Legacy: fetch rainfall via query params |
| `GET` | `/api/v1/oracle/flight` | Fetch flight delay from AviationStack |

### Auth & Health

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/v1/auth/login` | Verify Stellar wallet signature and issue JWT |
| `GET` | `/api/v1/health` | Service health check (includes DB ping) |

All responses follow the shape: `{ success: boolean, data?: any, error?: string }`.
Values are returned in 7-decimal fixed point as strings (matching Stellar asset precision).

---

## Local Setup

```bash
# 1. Clone and install dependencies
git clone <repo-url>
cd parashield-backend
npm install

# 2. Start PostgreSQL and Redis via Docker
docker-compose up -d

# 3. Configure environment
cp .env.example .env
# Edit .env with your KEEPER_SECRET_KEY and contract addresses

# 4. Run database migrations
npx prisma migrate dev

# 5. Start in development mode
npm run start:dev
```

The API will be available at `http://localhost:3001/api/v1`.
Swagger docs at `http://localhost:3001/docs`.

### Production build

```bash
npm run build
npm run start:prod
```

---

## API versioning (#713)

Every response carries an `X-API-Version` header advertising the semantic
version that served it (`v1` → `1.0.0`, `v2` → `2.0.0`), including error
responses, streamed responses (SSE/NDJSON) and responses that never reach a
route handler (CORS preflights, request timeouts).

- The version is taken from the route's `vN` segment (`/api/v1/...`), falling
  back to a request `x-api-version` header, then to `v1`.
- Requests for an unknown version (`/api/v3/...`) are rejected with `400`.
- `v1` responses also include `Deprecation: true` and
  `Link: </api/v2>; rel="successor"`.
- The header is exposed via CORS so browser clients can read it.

Resolution lives in `src/common/versioning/api-version.ts` and is applied by the
versioning interceptor (success paths), the global exception filter (error
paths) and an early middleware (everything else).

---

## CORS configuration

CORS is enabled in `src/main.ts` and controlled entirely via environment variables (see `.env.example`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `CORS_ORIGIN` | Yes | — | Allowed origin(s). Single origin or comma-separated list, e.g. `https://app.example.com,https://staging.example.com`. The server **refuses to start** without it. Wildcards (`*`) are not accepted — production must name explicit domains. |
| `CORS_METHODS` | No | `GET,POST,PUT,DELETE,OPTIONS` | Comma-separated list of allowed HTTP methods. |
| `CORS_ALLOWED_HEADERS` | No | `Content-Type,Authorization,x-wallet-address,x-wallet-signature,x-wallet-message,x-api-key,x-admin-api-key` | Comma-separated list of allowed request headers. |
| `CORS_CREDENTIALS` | No | `false` | Set to `true` to send `Access-Control-Allow-Credentials` (needed only for cookie-based clients; the API itself authenticates via headers). |

The defaults reproduce the previously hardcoded configuration, so no behavior changes unless the variables are set.

### Production CORS example

```dotenv
# .env (production)
CORS_ORIGIN=https://app.parashield.io,https://staging.parashield.io
```

Multiple origins are comma-separated. The server logs the active origin list at startup so you can confirm the value was parsed correctly.

---

## Database Connection Pool Sizing (#676)

Prisma connection pool sizing and timeouts are configurable via environment variables or directly as query parameters on `DATABASE_URL`.

| Environment Variable | Default | Description | Valid Range |
|---|---|---|---|
| `DATABASE_CONNECTION_LIMIT` | `10` | Maximum connections in the pool per application instance | 1 – 500 |
| `DATABASE_POOL_TIMEOUT` | `10` | Seconds a query waits for an available pool connection before throwing a timeout error | 1 – 300 |
| `DATABASE_CONNECT_TIMEOUT` | `5` | Seconds establishing a new TCP connection to PostgreSQL may take before timing out | 1 – 120 |

### Precedence

Explicit query parameters in `DATABASE_URL` (e.g. `postgresql://user:pass@host:5432/db?connection_limit=25&pool_timeout=15`) always take precedence over the environment variables. Environment variables are used only when the corresponding query parameter is not present in the URL.

Startup validation verifies all values are positive integers within sane bounds and fails fast with a clear error on misconfiguration.

### Sizing Guidance

When running multiple backend instances (e.g., in Kubernetes, ECS, or behind a load balancer), ensure the aggregate connections from all instances do not exceed PostgreSQL's `max_connections`:

$$\text{Total Connections} = (\text{Number of Instances} \times \text{DATABASE\_CONNECTION\_LIMIT}) + \text{Reserved Connections}$$

**Rule**: $\text{Total Connections} < \text{PostgreSQL } \texttt{max\_connections}$

- **Example 1 (Default)**: 5 instances $\times$ 10 connections = 50 connections. Fits comfortably within a default PostgreSQL `max_connections = 100` setting, leaving 50 connections for database migrations, administrative tasks, and replicas.
- **Example 2 (High Throughput)**: 10 instances $\times$ 25 connections = 250 connections. Requires PostgreSQL `max_connections` configured to $\ge 300$.

### Pool Monitoring & Health Checks

Pool utilization is monitored continuously via `/api/v1/health`:
- Exposes `active`, `idle`, `waiting`, `max`, `poolTimeout`, and `connectTimeout`.
- Flags health as degraded when connection utilization reaches `DB_POOL_EXHAUSTION_WARN_PERCENT` (default 90%) to detect exhaustion before queries queue or fail.
- Exposes genuine Prisma runtime engine metrics when supported.
- The effective pool configuration is logged at server startup.

---

## Oracle Reading Batch Persistence (#686)

To minimize database round-trips when storing high-frequency oracle readings, `OracleService` batches database inserts using multi-query transactions and a bounded in-memory buffer.

| Environment Variable | Default | Description | Valid Range |
|---|---|---|---|
| `ORACLE_BATCH_SIZE` | `50` | Maximum number of readings written in a single multi-row database transaction | 1 – 1000 |
| `ORACLE_FLUSH_INTERVAL_MS` | `1000` | Maximum time in milliseconds before pending buffered readings are flushed | 10 – 60000 |
| `ORACLE_BUFFER_MAX_SIZE` | `1000` | Maximum in-memory buffer capacity before backpressure is applied | 10 – 10000 |

Setting `ORACLE_BATCH_SIZE=1` disables buffering and executes immediate 1:1 inserts matching legacy behavior. Graceful shutdown hooks flush any remaining buffered readings before process termination.

### Load Testing

A k6 stress test script is provided in `loadtest/k6/pool-stress.js` to evaluate pool behavior and latency under concurrent load:

```bash
# Run pool stress test with k6
npm run test:load:pool

# Or with custom target URL and thresholds
BASE_URL=http://localhost:3001/api/v1 k6 run loadtest/k6/pool-stress.js
```

---

## Error handling (RFC 7807 Problem Details)

All error responses use `Content-Type: application/problem+json` conforming to [RFC 7807](https://datatracker.ietf.org/doc/html/rfc7807). Legacy fields remain present in the response body for backward compatibility, but are deprecated:

```json
{
  "type": "https://parashield.io/errors/not-found",
  "title": "Not Found",
  "status": 404,
  "detail": "Policy not found",
  "instance": "/api/v1/policies/abc123",
  "success": false,
  "errorCode": "NOT_FOUND",
  "error": "Policy not found",
  "message": "Policy not found",
  "statusCode": 404,
  "path": "/api/v1/policies/abc123",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### RFC 7807 Members

| Member | Type | Description |
|---|---|---|
| `type` | `string (URI)` | Stable URI reference identifying the error type. |
| `title` | `string` | Short human-readable summary of problem type. |
| `status` | `number` | HTTP status code. |
| `detail` | `string` | Human-readable explanation specific to this occurrence. |
| `instance` | `string (URI)` | Request path that generated the error. |
| `errors` | `array` | (Extension) Validation error details on 400 validation failures. |
| `correlationId` | `string` | (Extension) Request correlation ID when header is provided. |

### Legacy Fields (Deprecated)

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Always `false` for errors (Deprecated: use `status`). |
| `errorCode` | `string` | Stable machine-readable code (Deprecated: use `type`). |
| `error` | `string` \| `object` | Error message string (Deprecated: use `detail`). |
| `message` | `string` | Human-readable message (Deprecated: use `detail`). |
| `statusCode` | `number` | Mirrors the HTTP status code (Deprecated: use `status`). |
| `path` | `string` | The request path (Deprecated: use `instance`). |
| `timestamp` | `string` | ISO-8601 UTC timestamp. |

### Error codes


| `errorCode` | HTTP status | When it occurs |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request body fails class-validator rules (missing/invalid fields, wrong types). The `error` field contains an array of violation objects. |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT / wallet signature. Include `Authorization: Bearer <token>` or valid wallet headers. |
| `FORBIDDEN` | 403 | Authenticated but not allowed (e.g. accessing another wallet's policy, calling an operator-only endpoint without an API key). |
| `NOT_FOUND` | 404 | Resource does not exist (policy ID, claim ID, oracle key, etc.). |
| `CONFLICT` | 409 | Duplicate resource (e.g. submitting a claim when one is already active for the same policy). |
| `CLAIM_CONCURRENT_MODIFICATION` | 409 | The policy changed (or another claim was filed) while a claim was being submitted. Re-read the policy and retry. |
| `GONE` | 410 | Resource existed but is no longer accessible (e.g. an expired policy). |
| `TOO_MANY_REQUESTS` | 429 | Rate limit exceeded (60 requests per minute per IP). Back off and retry after the `Retry-After` header value. |
| `SERVICE_UNAVAILABLE` | 503 | Downstream dependency unavailable (database, Redis, Stellar RPC). |
| `BAD_REQUEST` | 400 | Generic bad request not covered by validation (malformed path param, unsupported value, etc.). |
| `INTERNAL_ERROR` | 500 | Unexpected server-side failure. The error is logged server-side; the response body intentionally omits internal details. |

### Handling validation errors (400)

When class-validator rejects a request body the `error` field is an array of NestJS constraint objects:

```json
{
  "success": false,
  "errorCode": "VALIDATION_ERROR",
  "error": {
    "message": ["wallet must be a string", "productId should not be empty"],
    "error": "Bad Request",
    "statusCode": 400
  },
  "statusCode": 400,
  "path": "/api/v1/policies/buy",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

Check each entry in `error.message` for the field name and violated constraint.

### Rate limiting (429)

The global throttle allows **60 requests per minute per IP**. When exceeded the response includes a `Retry-After` header with the number of seconds until the window resets. Clients should respect this header rather than retrying immediately.

The client IP is taken from Express's `req.ip`. `X-Forwarded-For` is **only** honoured for proxies listed in `TRUST_PROXY` — by default none are trusted, so a client cannot bypass the limit by spoofing that header. When running behind a load balancer or reverse proxy, set `TRUST_PROXY` to the number of trusted hops (e.g. `1`) or a comma-separated list of proxy IPs/CIDRs (e.g. `loopback,10.0.0.0/8`), otherwise every request will appear to come from the proxy's address.
Successful responses from guarded routes also include:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

Those values let clients and gateways track quota without waiting for a 429.

### Secrets management

If you want to source secrets from HashiCorp Vault instead of environment variables, set:

- `VAULT_ADDR`
- `VAULT_TOKEN`
- `VAULT_KV_PATH`

When all three are present, the server fetches the KV secret before Nest bootstraps and merges the returned key/value pairs into `process.env`. The Vault payload should use the standard KV v2 shape (`data.data`).

If none of the three are set, Vault is skipped. Once any of them is set, the server **fails fast** at startup (exit code 1, with the reason logged) instead of starting with missing secrets when:

- only some of `VAULT_ADDR` / `VAULT_TOKEN` / `VAULT_KV_PATH` are set (the missing ones are named)
- Vault is unreachable or does not answer within `VAULT_TIMEOUT_MS` (default `5000`)
- Vault returns a non-2xx status (with hints for 403/404) or a payload without `data.data`
- any key listed in the optional comma-separated `VAULT_REQUIRED_KEYS` is still unset after loading (the missing keys are named)

On success the loaded key names (never values) are logged.

#### Database credential rotation

When Vault is configured, the server re-reads the Vault secret every `VAULT_REFRESH_INTERVAL_MS` (default `300000`, i.e. 5 minutes; `0` disables polling). If `DATABASE_URL` or `DATABASE_REPLICA_URL` changed, it reconnects without a restart:

1. A new Prisma client is built from the new URL and connected **before** anything is swapped. If Vault is unreachable or the database rejects the new credentials, the error is logged, the existing connections stay in use, and the next refresh retries.
2. Once connected, the new client takes over all new queries.
3. The previous client is disconnected after `DATABASE_ROTATION_DRAIN_MS` (default `30000`) so in-flight queries and transactions can finish. Keep the old credentials valid in the database for at least that long after rotating them in Vault.

Only the database URLs are applied at runtime; other secrets are still read once at startup.

### OpenTelemetry tracing

Tracing is enabled when the OpenTelemetry packages are installed and the following variables are set:

- `OTEL_SERVICE_NAME`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS` if your collector requires auth headers

Set `OTEL_SDK_DISABLED=true` to turn tracing off without changing code.

### Load testing

A basic k6 scenario lives at [`loadtest/k6/smoke.js`](/Users/wisdom/projects/stellar/parashield-backend/loadtest/k6/smoke.js). Run it with:

```bash
npm run test:load
```

Override the target with:

```bash
BASE_URL=http://localhost:3001/api/v1 npm run test:load
```

### Success response shape

For reference, successful responses use the complementary envelope:

```json
{
  "success": true,
  "data": { ... }
}
```

Monetary values are returned as strings in 7-decimal fixed-point format matching Stellar asset precision (e.g. `"10.0000000"`).

### BigInt serialization & API contract change (#671)

All `BigInt` values (such as oracle readings, large policy IDs, and 64-bit timestamps or token amounts) are centrally serialized as decimal strings across all JSON responses, SSE streams, logging paths, and error envelopes.

> [!NOTE]
> **API Contract / Response-Shape Change**: Clients that previously parsed or expected numeric primitives for large integer or BigInt fields must now handle these fields as decimal strings (e.g. `"9223372036854775807"`). Requests accepting numeric IDs parse integer strings safely to `BigInt` and reject invalid, non-numeric, or floating-point input with HTTP 400 without `Number` precision degradation.

---

## Security & database configuration notes

- **Input sanitization**: a global middleware (`InputSanitizationMiddleware`, registered in `src/main.ts`) trims every string in JSON/urlencoded request bodies and escapes `<`/`>` before validation and persistence, so markup cannot survive into stored values or reflected responses.
- **Connection pooling**: Prisma pool sizing is applied at runtime to the datasource URL (`connection_limit=10`, `pool_timeout=10`, `connect_timeout=5`). Override each value with `DATABASE_CONNECTION_LIMIT`, `DATABASE_POOL_TIMEOUT`, `DATABASE_CONNECT_TIMEOUT`, or by putting the parameter directly in `DATABASE_URL`.
- **Response header hardening (#711)**: `applySecurityHeaders()` (`src/common/security/response-header-hardening.ts`, called from `src/main.ts`) disables Express's `X-Powered-By`, applies [helmet](https://helmetjs.github.io/) and strips implementation-revealing headers (`Server`, `X-Powered-By`, `X-AspNet-Version`, `X-AspNetMvc-Version`, `X-Runtime`, `Via`) from every response. Stripping is done at the header level, so headers added later by the framework or an upstream proxy are removed too. Extra names can be added via `extraHeadersToStrip`.

---

## Transaction strategy

Postgres defaults to `READ COMMITTED`. Under it, two concurrent "check for an existing claim, then insert one" transactions can both pass the check, which can double-pay a policy. Every write that can lead to or record a payout therefore goes through `src/prisma/financial-transaction.ts`:

- **`financialTransaction(prisma, label, fn)`** (interactive) and **`financialBatch(prisma, label, () => [...ops])`** (array form) run at **`SERIALIZABLE`** isolation (`maxWait` 5s, `timeout` 10s). When transactions conflict, Postgres aborts one of them with a serialization failure (SQLSTATE `40001`, Prisma `P2034`) rather than letting both commit.
- **Serialization failures are retried** up to 3 attempts in total, with jittered exponential backoff. The retry re-runs the whole transaction, so it sees the winner's committed rows (for example, the duplicate guard now finds the claim and returns `AlreadyProcessed` / 409). Interactive callbacks must therefore have no side effects outside `tx`: contract calls, SSE events and webhooks happen after the transaction commits. `financialBatch` takes a factory because a `PrismaPromise` can't be re-run. If a submission is still conflicting after the last attempt, `submitClaim` returns 409 `CLAIM_CONCURRENT_MODIFICATION`.
- **Optimistic locking** uses `Policy.version`. Every policy status write increments it. Claim flows guard their policy writes on the version they read:
  - `autoProcess` gates `ACTIVE → PROCESSING` only on the version it validated, and its later `→ CLAIMED` / `→ ACTIVE` writes match only the version its own gate produced. A policy that the stuck-`PROCESSING` sweep reverted and another worker re-gated is back in `PROCESSING` but at a higher version, so the stale attempt's writes miss instead of clobbering it (the ABA case a status-only guard can't detect).
  - `submitClaim` re-reads the policy inside its transaction and rejects the submission if the status or version changed after validation.

| Operation | Isolation | Guard |
|---|---|---|
| `autoProcess` reservation: duplicate guard, `ACTIVE → PROCESSING` gate, claim insert (one transaction) | Serializable + retry | status + `version` |
| `autoProcess` outcome writes (`PAID`/`CLAIMED`, `REJECTED`, `FAILED` + revert) | Serializable + retry | `status = PROCESSING` + gated `version` |
| `submitClaim`: policy re-check, duplicate guard, claim insert (one transaction) | Serializable + retry | `version` + partial unique index on non-terminal claims |
| Stuck-`PROCESSING` recovery | Serializable + retry | status + `updatedAt` cutoff |
| Cancel / expire policy | single-statement `updateMany` (atomic on its own) | status; bumps `version` |
| Read-only pagination (`findMany` + `count`) | default | — |

The database-level partial unique index on `Claim(policyId) WHERE status IN ('PENDING','PROCESSING')` remains as a backstop. It does not cover terminal statuses such as `PAID`, which is why the isolation level matters.

Concurrency tests in `src/claims/claims.concurrency.spec.ts` run against a real Postgres. They are skipped unless `CONCURRENCY_TEST_DATABASE_URL` points at a **disposable** database (its tables are truncated):

```bash
DATABASE_URL=postgresql://.../parashield_test npx prisma db push
CONCURRENCY_TEST_DATABASE_URL=postgresql://.../parashield_test npx jest claims.concurrency
```

---

## Oracle data sources

| Data | Source | Key required |
|---|---|---|
| Rainfall, temperature, wind | [Open-Meteo](https://open-meteo.com) | No |
| Flight delay | [AviationStack](https://aviationstack.com) | Yes (`AVIATIONSTACK_API_KEY`) |
| DeFi exploit | Stellar RPC event stream | No |

**Threshold evaluation (#712):** oracle readings are 7-decimal fixed point (e.g. `324000000` = 32.4) and product thresholds are `Decimal(20,7)`. Trigger comparisons are done on exact scaled `BigInt` values (`src/common/utils/decimal.ts`) rather than `parseFloat`, so the last decimal place is never lost and a reading exactly equal to the threshold never triggers (strict `LessThan` / greater-than).

---

## Project layout

```
src/
├── main.ts                          bootstrap, Swagger, global middleware
├── app.module.ts                    root module
├── stellar/
│   ├── stellar.module.ts
│   └── stellar.service.ts           keeper keypair, RPC wrapper, tx builder, retry logic
├── oracle/
│   ├── oracle.service.ts            fetch external data, persist to DB
│   ├── oracle.worker.ts             @Cron hourly poll + on-chain submit stub
│   ├── oracle.controller.ts         REST endpoints
│   └── dto/oracle-reading.dto.ts
├── policy/
│   ├── policy.service.ts            premium calculation, DB reads/writes
│   ├── policy.controller.ts         REST endpoints
│   ├── policy.module.ts
│   ├── policy-status.machine.ts     state machine for valid policy transitions
│   └── dto/
│       ├── buy-policy.dto.ts
│       └── policy-response.dto.ts
├── claims/
│   ├── claims.service.ts            claim submission, duplicate guard, auto-process
│   ├── claims.worker.ts             @Cron hourly scan of expiring policies
│   ├── claims.controller.ts         REST endpoints
│   ├── claims.module.ts
│   └── dto/submit-claim.dto.ts
├── auth/
│   ├── auth.middleware.ts           Stellar signature verification
│   ├── auth.controller.ts           POST /auth/login
│   ├── auth.module.ts
│   └── jwt.service.ts               JWT sign/verify
├── health/
│   ├── health.controller.ts         GET /health
│   └── health.module.ts
├── prisma/
│   ├── prisma.service.ts
│   └── prisma.module.ts
└── common/
    ├── filters/
    │   └── http-exception.filter.ts  structured error responses
    ├── interceptors/
    │   └── logging.interceptor.ts    request duration logging
    └── guards/
        └── throttle.guard.ts         IP-based rate limiting
```

---

## Keeper account

The keeper is a Stellar account (`KEEPER_SECRET_KEY`) that signs:
- `oracle-verifier.submit_data(...)` — one tx per oracle reading per hour
- `claims-processor.auto_process(policy_id)` — one tx per active policy per hour

Fee per tx: ~0.00001 XLM. Fund via `stellar keys fund <address> --network testnet` on testnet.

---

## Redis connection & startup retry (#710)

The app creates a single shared Redis client (`REDIS_URL`) used for rate limiting,
idempotency, distributed locks and the policy-state cache. The client is created
with `lazyConnect`, so construction never blocks; the first connection is performed
during startup by `RedisConnectionService` (`src/redis/redis-connection.service.ts`).

Startup behaviour:

- The first connection is retried with exponential backoff, a capped delay and
  jitter. A per-attempt timeout guarantees a hung connect cannot stall startup.
- If every attempt fails, startup fails fast with one actionable error naming the
  Redis `host:port` (never the username/password or full URL).
- Once connected, runtime reconnection is handed back to ioredis (its
  `retryStrategy`/`reconnectOnError` handle transient drops).

Tuning (all optional — defaults shown):

| Variable | Default | Description |
| --- | --- | --- |
| `REDIS_STARTUP_MAX_ATTEMPTS` | `5` | Total connection attempts, including the first. |
| `REDIS_STARTUP_INITIAL_DELAY_MS` | `200` | Delay before the second attempt; doubles each retry. |
| `REDIS_STARTUP_MAX_DELAY_MS` | `3000` | Upper bound for the backoff delay. |
| `REDIS_STARTUP_ATTEMPT_TIMEOUT_MS` | `5000` | Per-attempt timeout. |

Invalid values (negative, non-integer or out of range) fail startup with a clear
validation error. Credentials embedded in `REDIS_URL` are never logged.

---

## v2 roadmap

- Full Soroban SDK transaction builder for all write paths (currently stubbed with `// TODO` markers)
- WebSocket subscription for real-time policy/claim status updates
- Redis-backed rate limiting for multi-instance deployments

---

## Related

- [parashield-contracts](https://github.com/Parashield-Protocol/parashield-contracts) — Soroban contracts
- [parashield-frontend](https://github.com/Parashield-Protocol/parashield-frontend) — Next.js UI
