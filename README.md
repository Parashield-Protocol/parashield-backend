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
- **Wallet-header auth**: a legacy request-signature flow for protected API routes. Clients send `x-wallet-address`, `x-wallet-message`, and `x-wallet-signature`; `AuthMiddleware` verifies the Stellar signature and sets `req.wallet`.

Operator-only oracle fetch endpoints require either `x-api-key: <ORACLE_OPERATOR_API_KEY>` or an admin JWT. Public endpoints such as `/api/v1/products`, `/api/v1/oracle/latest/:key`, `/api/v1/health`, and `/docs` do not run wallet-header middleware.

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
| `POST` | `/api/v1/policies/buy` | Calculate premium and get a purchase quote |

### Claims

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/v1/claims/submit` | Submit a manual claim |
| `POST` | `/api/v1/claims/:policyId/auto` | Trigger automatic claim evaluation (keeper only) |
| `GET` | `/api/v1/claims/:id` | Get claim details by ID |
| `GET` | `/api/v1/claims/history/:wallet` | Get all claims for a wallet address |

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

## Error handling

All error responses follow the same envelope shape regardless of endpoint:

```json
{
  "success": false,
  "errorCode": "NOT_FOUND",
  "error": "Policy not found",
  "statusCode": 404,
  "path": "/api/v1/policies/abc123",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Always `false` for errors. |
| `errorCode` | `string` | Stable machine-readable code (see table below). Key off this, not `error`. |
| `error` | `string` \| `object` | Human-readable message, or NestJS validation error details for 400s. May change between versions. |
| `statusCode` | `number` | Mirrors the HTTP status code. |
| `path` | `string` | The request path that produced the error. |
| `timestamp` | `string` | ISO-8601 UTC timestamp. |

### Error codes

| `errorCode` | HTTP status | When it occurs |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request body fails class-validator rules (missing/invalid fields, wrong types). The `error` field contains an array of violation objects. |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT / wallet signature. Include `Authorization: Bearer <token>` or valid wallet headers. |
| `FORBIDDEN` | 403 | Authenticated but not allowed (e.g. accessing another wallet's policy, calling an operator-only endpoint without an API key). |
| `NOT_FOUND` | 404 | Resource does not exist (policy ID, claim ID, oracle key, etc.). |
| `CONFLICT` | 409 | Duplicate resource (e.g. submitting a claim when one is already active for the same policy). |
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

---

## Security & database configuration notes

- **Input sanitization**: a global middleware (`InputSanitizationMiddleware`, registered in `src/main.ts`) trims every string in JSON/urlencoded request bodies and escapes `<`/`>` before validation and persistence, so markup cannot survive into stored values or reflected responses.
- **Connection pooling**: Prisma pool sizing is applied at runtime to the datasource URL (`connection_limit=10`, `pool_timeout=10`, `connect_timeout=5`). Override each value with `DATABASE_CONNECTION_LIMIT`, `DATABASE_POOL_TIMEOUT`, `DATABASE_CONNECT_TIMEOUT`, or by putting the parameter directly in `DATABASE_URL`.

---

## Oracle data sources

| Data | Source | Key required |
|---|---|---|
| Rainfall, temperature, wind | [Open-Meteo](https://open-meteo.com) | No |
| Flight delay | [AviationStack](https://aviationstack.com) | Yes (`AVIATIONSTACK_API_KEY`) |
| DeFi exploit | Stellar RPC event stream | No |

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

## v2 roadmap

- Full Soroban SDK transaction builder for all write paths (currently stubbed with `// TODO` markers)
- WebSocket subscription for real-time policy/claim status updates
- Redis-backed rate limiting for multi-instance deployments

---

## Related

- [parashield-contracts](https://github.com/Parashield-Protocol/parashield-contracts) — Soroban contracts
- [parashield-frontend](https://github.com/Parashield-Protocol/parashield-frontend) — Next.js UI
