/**
 * #EnhancementDocs — Real-time connection lifecycle documentation injected
 * into the Swagger description so developers understand how to establish,
 * maintain, and tear down live connections to this API.
 *
 * ParaShield uses two real-time transport mechanisms:
 *   1. Server-Sent Events (SSE)  — policy status change streams
 *   2. Webhooks                  — push notifications to caller-supplied URLs
 *
 * Neither requires a persistent bidirectional socket; SSE is a standard
 * HTTP/1.1 chunked-transfer stream over a single long-lived GET request.
 */

export const REALTIME_DOCS = `
## Real-Time Connection Lifecycle

ParaShield delivers live updates through two complementary mechanisms: **Server-Sent Events (SSE)** for
browser/client-initiated streams and **Webhooks** for server-to-server push notifications.

---

### Server-Sent Events (SSE)

SSE runs over a standard HTTPS connection using the \`text/event-stream\` content type. No WebSocket
upgrade is required — the connection is a long-lived HTTP GET request.

#### Endpoint

\`\`\`
GET /api/v1/policies/:id/events
Authorization: Bearer <jwt>
\`\`\`

#### Connection lifecycle

| Phase | What happens |
|-------|--------------|
| **Connect** | Client opens an \`EventSource\` (or equivalent long-GET). The server authenticates the JWT, verifies policy ownership, emits the *current* status immediately, then keeps the connection open. |
| **Active** | The server pushes a \`MessageEvent\` every time the policy status changes. Each event carries a JSON payload: \`{ policyId, status, timestamp }\`. |
| **Heartbeat** | The server sends an SSE comment (\`: ping\\n\\n\`) every 25 seconds to keep the connection alive through proxies and load balancers that close idle TCP connections. |
| **Disconnect** | Close the \`EventSource\` object when you no longer need updates. The server detects the closed socket and releases its subscriber automatically — no explicit close frame is needed. |
| **Reconnect** | The browser \`EventSource\` API retries automatically on network drop. Supply \`Last-Event-ID\` to resume from the last received event (optional; the server replays the current status on every new connection regardless). |

#### Client example

\`\`\`js
const token = '<your-jwt>';
const es = new EventSource(
  \`/api/v1/policies/\${policyId}/events\`,
  { withCredentials: true }
);

// Attach the JWT for environments that cannot set headers on EventSource
// by appending ?token=<jwt> or using a cookie-based session instead.

es.onopen    = ()  => console.log('SSE connection established');
es.onmessage = (e) => {
  const { policyId, status, timestamp } = JSON.parse(e.data);
  console.log(\`Policy \${policyId} → \${status} at \${new Date(timestamp).toISOString()}\`);
};
es.onerror   = ()  => {
  // EventSource retries automatically; log the error for diagnostics only
  console.warn('SSE connection lost, reconnecting…');
};

// Tear down when no longer needed
function cleanup() { es.close(); }
\`\`\`

#### Status values

| Value | Meaning |
|-------|---------|
| \`ACTIVE\` | Policy is in force and eligible for claims |
| \`PROCESSING\` | A claim or activation is being processed on-chain |
| \`CLAIMED\` | A claim payout has been executed |
| \`CANCELLED\` | Policy was cancelled before expiry |
| \`EXPIRED\` | Policy coverage period has ended |

#### Error handling

| HTTP status | Cause | Fix |
|-------------|-------|-----|
| 401 | Missing or expired JWT | Re-authenticate and reconnect with a fresh token |
| 403 | Policy belongs to a different wallet | Do not retry — ownership mismatch |
| 404 | Unknown policy ID | Verify the policy ID before opening the stream |
| 429 | Rate limit exceeded | Wait \`Retry-After\` seconds before reconnecting |

---

### Webhooks (server-to-server push)

Register a callback URL once; the server delivers a signed POST request for every matching event.
This is the preferred pattern for backend integrations where \`EventSource\` is not available.

#### Supported events

| Event type | Triggered when |
|------------|----------------|
| \`policy.status.change\` | A policy transitions to any new status |
| \`claim.status.change\` | A claim transitions to any new status |

#### Registration

\`\`\`
POST /api/v1/webhooks/register
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "url": "https://your-server.example.com/hooks/parashield",
  "events": ["policy.status.change", "claim.status.change"],
  "secret": "<your-signing-secret>"
}
\`\`\`

#### Delivery lifecycle

| Phase | What happens |
|-------|--------------|
| **Trigger** | Server emits an event internally when a status change is persisted. |
| **Delivery** | Server sends a POST to your registered URL within ~1 second. The body is a JSON payload signed with HMAC-SHA256 using your secret (signature in \`X-Parashield-Signature\` header). |
| **Acknowledgement** | Your endpoint must return HTTP 200–299. Any other status or a network error is treated as a delivery failure. |
| **Retry** | Failed deliveries are retried with exponential back-off (3 attempts: 10 s, 30 s, 120 s). After 3 failures the delivery is dropped and logged. |
| **Deregistration** | Delete the webhook registration to stop receiving events. |

#### Payload signature verification

\`\`\`js
const crypto = require('crypto');

function verifySignature(body, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(\`sha256=\${expected}\`)
  );
}
\`\`\`

> **Security note:** Always verify the signature before processing the payload. Reject requests where
> the signature does not match — they may be spoofed.

---

### Choosing between SSE and Webhooks

| | SSE | Webhooks |
|-|-----|----------|
| Best for | Browser / frontend apps | Backend services |
| Transport | HTTP long-GET (client initiates) | HTTP POST (server initiates) |
| Authentication | JWT in \`Authorization\` header | HMAC signature per delivery |
| Reconnect on drop | Automatic (browser \`EventSource\`) | Retried by server |
| Firewall friendly | Yes (outbound from client) | Requires inbound port on your server |
`;
