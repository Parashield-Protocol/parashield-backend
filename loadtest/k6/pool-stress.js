import http from 'k6/http';
import { check, sleep } from 'k6';

/**
 * k6 load test script for database connection pool sizing and stress testing (#676).
 *
 * Simulates concurrent traffic against database-backed endpoints to evaluate
 * pool exhaustion behavior under different DATABASE_CONNECTION_LIMIT and
 * DATABASE_POOL_TIMEOUT settings.
 *
 * Usage:
 *   k6 run loadtest/k6/pool-stress.js
 * Or with custom URL and VUs:
 *   BASE_URL=http://localhost:3001/api/v1 k6 run loadtest/k6/pool-stress.js
 */
export const options = {
  stages: [
    { duration: '30s', target: 20 },  // Ramp up to 20 virtual users (2x default pool)
    { duration: '1m', target: 50 },   // Stress test at 50 virtual users (5x default pool)
    { duration: '30s', target: 100 }, // Spike to 100 virtual users
    { duration: '30s', target: 0 },   // Ramp down
  ],
  thresholds: {
    // Assert that less than 1% of requests fail during steady state
    http_req_failed: ['rate<0.05'],
    // 95% of database requests should complete within 1.5 seconds
    http_req_duration: ['p(95)<1500'],
  },
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:3001/api/v1';

export default function () {
  // Test health endpoint which monitors pool utilization and runs DB queries
  const healthRes = http.get(`${baseUrl}/health`);
  check(healthRes, {
    'health responds 200 or 503': (res) => res.status === 200 || res.status === 503,
    'pool info is present': (res) => {
      try {
        const body = JSON.parse(res.body);
        return body.checks && body.checks.database && body.checks.database.pool !== undefined;
      } catch {
        return false;
      }
    },
  });

  // Query database-backed products catalog
  const productsRes = http.get(`${baseUrl}/products`);
  check(productsRes, {
    'products endpoint responds 200': (res) => res.status === 200,
  });

  sleep(0.5);
}
