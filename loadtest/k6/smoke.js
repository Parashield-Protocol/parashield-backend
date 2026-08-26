import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 25 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<750'],
  },
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:3001/api/v1';

export default function () {
  const response = http.get(`${baseUrl}/health`);
  check(response, {
    'health endpoint responds': (res) => res.status === 200,
    'rate limit headers present': (res) =>
      (res.headers['X-RateLimit-Limit'] ?? res.headers['x-ratelimit-limit']) !== undefined &&
      (res.headers['X-RateLimit-Remaining'] ?? res.headers['x-ratelimit-remaining']) !== undefined &&
      (res.headers['X-RateLimit-Reset'] ?? res.headers['x-ratelimit-reset']) !== undefined,
  });
  sleep(1);
}
