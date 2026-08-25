# About this PR

This PR resolves 4 enhancement issues:

## Changes

### #375 - API versioning strategy
- Implemented API versioning interceptor that adds `X-API-Version` response header
- Added `Deprecation` header for v1 with `Link` header pointing to v2 successor
- Updated Swagger config to support `x-api-version` header for API version negotiation

### #373 - Pagination on policy and claims list endpoints
- Added `page` and `limit` query parameters to `GET /api/v1/products` endpoint
- Updated `getActiveProducts` service method to support Prisma-based pagination with `take`/`skip`
- Claims list endpoints (`getClaimsByWalletQuery`, `getClaimHistory`) already had pagination

### #372 - Rate limiting on claim submission endpoint
- Added claim-specific rate limiting (`limit: 5/60s`) to `POST /api/v1/claims` endpoint
- Uses `@Throttle` decorator with stricter limits than global throttler (60/60s)

### #374 - Webhook support for policy/claim status changes
- Created `WebhooksService` with register/unregister/list and status notification methods
- Created `WebhooksController` with `POST /api/v1/webhooks/register` and `GET /api/v1/webhooks` endpoints
- Policy status changes (e.g., cancel) trigger webhooks with `policy.status.change` event
- Claim status changes (e.g., PROCESSING → FAILED, PROCESSING → CLAIMED) trigger webhooks with `claim.status.change` event

## Issue Closure

This PR closes the following issues using GitHub keyword syntax:

- **Closes #375** - API versioning strategy
- **Closes #373** - No pagination on policy and claims list endpoints
- **Closes #372** - No rate limiting on claim submission endpoint
- **Closes #374** - No webhook support for policy/claim status changes

## Verification

- All endpoints return proper pagination metadata (`{ success, data, total, page, limit }`)
- Rate limiting prevents claim submission spam beyond 5 attempts per 60 seconds
- Webhooks can be registered with specific events (`policy.status.change`, `claim.status.change`)
- API versioning headers are present on all responses