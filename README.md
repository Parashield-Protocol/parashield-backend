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
| `POST` | `/api/v1/oracle/fetch/rainfall` | Fetch rainfall data from Open-Meteo |
| `POST` | `/api/v1/oracle/fetch/temperature` | Fetch temperature data from Open-Meteo |
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
