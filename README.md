# parashield-backend

NestJS API server for Parashield. Two jobs: serve the frontend, and run the keeper daemon that submits oracle data and triggers claims on-chain.

---

## What it does

**REST API** — the frontend reads insurance products, user policies, and claim status through this server. In v1, reads are proxied from the Soroban contracts via RPC simulation. A Prisma + PostgreSQL event index is the v2 path.

**Keeper daemon** — two scheduled workers:
- `OracleWorker` runs hourly. Fetches weather/flight data from external APIs and submits readings to the `oracle-verifier` contract.
- `ClaimsWorker` runs hourly. Iterates active policies and calls `claims-processor.auto_process()` for each. If a trigger is met, the contract pays the policyholder without any user action.

---

## Endpoints

```
GET  /api/v1/policies/products           list active insurance products
GET  /api/v1/policies?wallet=<address>   policies owned by a wallet
GET  /api/v1/policies/:id               single policy

POST /api/v1/claims                     submit a claim manually
                                         body: { claimant, policyId }
POST /api/v1/claims/:policyId/auto      keeper-trigger auto evaluation
GET  /api/v1/claims/:id                 claim status

GET  /api/v1/oracle/rainfall            fetch rainfall from Open-Meteo
                                         ?lat=-0.0917&lng=34.7679&year=2026&month=6
GET  /api/v1/oracle/flight              fetch flight delay
                                         ?flight=KQ100&date=2026-06-15
```

All values returned in 7-decimal fixed point as strings (matching Stellar asset precision). `1_000_000_000 = 100.0000000 USDC`.

---

## Oracle data sources

| Data | Source | Key required |
|---|---|---|
| Rainfall, temperature, wind | [Open-Meteo](https://open-meteo.com) | No |
| Flight delay | [AviationStack](https://aviationstack.com) | Yes |
| DeFi exploit | Stellar RPC event stream | No |

---

## Project layout

```
src/
├── main.ts
├── app.module.ts
├── stellar/
│   ├── stellar.module.ts
│   └── stellar.service.ts       keeper keypair, RPC wrapper, tx builder
├── oracle/
│   ├── oracle.service.ts        fetch external data
│   ├── oracle.worker.ts         @Cron hourly poll + on-chain submit
│   └── oracle.controller.ts
├── policy/
│   ├── policy.service.ts        read from policy-engine contract
│   └── policy.controller.ts
└── claims/
    ├── claims.service.ts        submit/evaluate claims
    ├── claims.worker.ts         @Cron hourly auto-process
    └── claims.controller.ts
```

---

## Setup

```bash
npm install
cp .env.example .env
```

Required env vars:

```env
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
KEEPER_SECRET_KEY=S...                          # account that signs keeper txs
ORACLE_VERIFIER_CONTRACT=C...
POLICY_ENGINE_CONTRACT=C...
CLAIMS_PROCESSOR_CONTRACT=C...
```

Optional:

```env
AVIATIONSTACK_API_KEY=...   # only needed for flight delay data
PORT=3001
```

```bash
npm run start:dev    # development
npm run build && npm run start:prod
```

---

## Keeper account

The keeper is a Stellar account (`KEEPER_SECRET_KEY`) that signs:
- `oracle-verifier.submit_data(...)` — one tx per oracle reading per hour
- `claims-processor.auto_process(policy_id)` — one tx per active policy per hour

Fee per tx: ~0.00001 XLM. Fund via `stellar keys fund <address> --network testnet` on testnet.

The keeper's address must be registered in the oracle-verifier contract:
```bash
stellar contract invoke --id $ORACLE_VERIFIER_CONTRACT \
  -- add_oracle \
  --admin $DEPLOYER \
  --oracle $KEEPER_ADDRESS \
  --data_type weather \
  --weight 90
```

---

## v2 roadmap

- Prisma + PostgreSQL: index contract events for fast historical queries
- Full Soroban SDK transaction builder for all write paths (current state: stubs with `// TODO` markers)
- WebSocket subscription for real-time policy/claim status updates

---

## Related

- [parashield-contracts](https://github.com/Parashield-Protocol/parashield-contracts) — Soroban contracts
- [parashield-frontend](https://github.com/Parashield-Protocol/parashield-frontend) — Next.js UI
