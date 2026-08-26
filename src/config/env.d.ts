// #340 — every environment variable this project reads, in one place, typed.
// Augmenting NodeJS.ProcessEnv gives autocomplete and catches typos on any
// `process.env.X` access (TypeScript rejects unknown keys and enforces
// string-or-undefined). ConfigService.get() calls are unaffected by this file
// since they type each call site's return value explicitly (`.get<string>(...)`)
// rather than going through ConfigService<EnvironmentVariables>; wiring that up
// would mean parameterizing every ConfigService injection across the project,
// which is a larger follow-up beyond this fix.
export interface EnvironmentVariables {
  // Required at startup (validated in app.module.ts's validateConfig)
  JWT_SECRET: string;
  DATABASE_URL: string;
  STELLAR_RPC_URL: string;
  KEEPER_SECRET_KEY: string;
  CORS_ORIGIN: string;

  // Optional, with fallback behavior defined at each call site
  PORT?: string;
  HORIZON_URL?: string;
  STELLAR_NETWORK?: string;
  REDIS_URL?: string;
  ADMIN_API_KEY?: string;
  ORACLE_OPERATOR_API_KEY?: string;
  AVIATIONSTACK_API_KEY?: string;
  ORACLE_MIN_CONFIDENCE?: string;
  ORACLE_VERIFIER_CONTRACT?: string;
  POLICY_ENGINE_CONTRACT?: string;
  CLAIMS_PROCESSOR_CONTRACT?: string;
  USDC_CONTRACT?: string;
  POOL_CAPACITY_XLM?: string;
  KEEPER_MIN_BALANCE_XLM?: string;

  // #379 — API key rotation (previous keys + grace window in minutes)
  ORACLE_OPERATOR_API_KEY_PREVIOUS?: string;
  ADMIN_API_KEY_PREVIOUS?: string;
  API_KEY_ROTATION_GRACE_MINUTES?: string;

  // #382 — CORS tuning (defaults in src/main.ts)
  CORS_METHODS?: string;
  CORS_ALLOWED_HEADERS?: string;
  CORS_CREDENTIALS?: string;

  // #381 — Prisma connection pool overrides (see src/prisma/prisma.service.ts)
  DATABASE_CONNECTION_LIMIT?: string;
  DATABASE_POOL_TIMEOUT?: string;
  DATABASE_CONNECT_TIMEOUT?: string;
}

declare global {
  namespace NodeJS {
    interface ProcessEnv extends EnvironmentVariables {}
  }
}
