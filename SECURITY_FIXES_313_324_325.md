# Security Fixes: Issues #313, #324, #325

## Summary

This document details the security fixes applied to address issues #313, #324, and #325.

---

## Issue #325: Dual Redundant Rate Limiting ✅ FIXED

### Problem

Two global rate limiting guards were running on every request:
1. **NestJS ThrottlerGuard** (Redis-backed, configured in `app.module.ts`)
2. **Custom ThrottleGuard** (in-memory Map, registered in `main.ts`)

Both guards counted requests independently, causing:
- **False 429 responses** in multi-instance deployments
- **Inconsistent rate limit enforcement** across instances
- **Memory leaks** from the in-memory Map in long-running processes
- **Performance overhead** from duplicate counting

### Solution

**Removed the custom ThrottleGuard** from `main.ts` line 42.

The NestJS ThrottlerGuard (Redis-backed) is sufficient and provides:
- **Distributed counting** via Redis (works across multiple instances)
- **Persistent rate limits** (survives instance restarts)
- **Better performance** (single guard execution per request)

### Files Changed

- `src/main.ts` - Removed `app.useGlobalGuards(new ThrottleGuard())`

### Code Change

**Before:**
```typescript
// Global guards
app.useGlobalGuards(new ThrottleGuard());
```

**After:**
```typescript
// Global guards
// REMOVED: app.useGlobalGuards(new ThrottleGuard());
// Issue #325: Duplicate rate limiting removed. ThrottlerGuard (Redis-backed) is already
// registered globally in app.module.ts via APP_GUARD provider. The custom ThrottleGuard
// (in-memory Map) was causing conflicting counts in multi-instance deployments.
```

### Impact

✅ **No more false 429 errors** in multi-instance setups  
✅ **Consistent rate limiting** across all instances  
✅ **Reduced memory footprint** (no in-memory Map)  
✅ **Better performance** (single guard execution)

---

## Issue #324: Constant-Time Nonce Comparison ✅ ALREADY FIXED

### Problem Statement

The issue reported that `AuthMiddleware` used plain `!==` for nonce comparison instead of constant-time comparison (`crypto.timingSafeEqual`), making it vulnerable to timing attacks.

### Current Status

**Issue is already resolved in the codebase.**

The code at `src/auth/auth.middleware.ts` lines 75-82 **already uses `crypto.timingSafeEqual`**:

```typescript
try {
  const messageBuffer = Buffer.from(message, 'utf8');
  const nonceBuffer = Buffer.from(challenge.nonce, 'utf8');
  if (messageBuffer.length !== nonceBuffer.length || !timingSafeEqual(messageBuffer, nonceBuffer)) {
    this.logger.warn(`Header-auth rejected: message does not match nonce for ${address}`);
    res.status(401).json({ statusCode: 401, message: 'Invalid challenge message' });
    return;
  }
} catch (err) {
  this.logger.warn(`Header-auth rejected: nonce comparison failed for ${address}`);
  res.status(401).json({ statusCode: 401, message: 'Invalid challenge message' });
  return;
}
```

### Security Analysis

✅ **Length check before comparison** - Prevents timing leaks from length differences  
✅ **Constant-time comparison** - Uses `crypto.timingSafeEqual` for the actual nonce check  
✅ **Try-catch protection** - Handles any comparison errors gracefully  
✅ **Secure logging** - No nonce values in logs

### Verification

The `timingSafeEqual` import is present at the top of the file:
```typescript
import { timingSafeEqual } from 'crypto';
```

And the function is correctly used on line 77 with properly sized buffers.

### Conclusion

**No action needed.** The issue has been resolved in a previous commit. The nonce comparison is already using constant-time comparison as required for security best practices.

---

## Issue #313: Soroban Contract Underflow Risk ⚠️ ADVISORY

### Problem

The Soroban smart contract function `compute_rate` in `lib.rs` can potentially underflow if called with invalid inputs:

```rust
fn compute_rate(credit_quality: u32, green_impact: u32) -> u32 {
    let avg = (credit_quality + green_impact) / 2;
    let discount = avg * MAX_DISCOUNT_BPS / 100;
    BASE_RATE_BPS - discount  // ⚠️ Can underflow if discount > BASE_RATE_BPS
}
```

While `update_impact_score_internal` validates each score is ≤100, `compute_rate` itself has no upper-bound guard. If `avg > 200` (impossible with validated inputs but possible from a new code path), the subtraction could underflow:
- **Debug mode**: Panic
- **Release mode**: Wrap around (undefined behavior)

### Context

This issue affects the **Soroban smart contract** (Rust), not the TypeScript backend in this repository. The backend's `stellar.service.ts` calls the contract but doesn't implement `compute_rate` itself.

### Recommended Fix (for Contract Repository)

**Option 1: Saturating Subtraction**
```rust
fn compute_rate(credit_quality: u32, green_impact: u32) -> u32 {
    let avg = (credit_quality + green_impact) / 2;
    let discount = avg * MAX_DISCOUNT_BPS / 100;
    BASE_RATE_BPS.saturating_sub(discount)  // Returns 0 if discount > BASE_RATE_BPS
}
```

**Option 2: Explicit Guard**
```rust
fn compute_rate(credit_quality: u32, green_impact: u32) -> u32 {
    let avg = (credit_quality + green_impact) / 2;
    let discount = avg * MAX_DISCOUNT_BPS / 100;
    if discount > BASE_RATE_BPS {
        0
    } else {
        BASE_RATE_BPS - discount
    }
}
```

**Option 3: Input Validation**
```rust
fn compute_rate(credit_quality: u32, green_impact: u32) -> u32 {
    // Validate inputs
    assert!(credit_quality <= 100, "credit_quality must be <= 100");
    assert!(green_impact <= 100, "green_impact must be <= 100");
    
    let avg = (credit_quality + green_impact) / 2;
    let discount = avg * MAX_DISCOUNT_BPS / 100;
    BASE_RATE_BPS - discount  // Now safe
}
```

### Backend Considerations

The TypeScript backend should:
1. **Validate scores before contract calls** (already done via DTOs)
2. **Handle contract errors gracefully**
3. **Log unexpected rate calculation results**
4. **Monitor for zero rates** (potential indicator of underflow)

### Action Required

This issue should be addressed in the **Soroban contract repository**, not this backend repository. The backend is already doing its part by validating inputs via DTOs before calling the contract.

### Files to Update (in contract repository)

- `contracts/lib.rs` - Add saturating_sub or explicit guard to `compute_rate`
- `contracts/logic.rs` - Ensure `calculate_interest_rate` guard is consistent
- Contract tests - Add test cases for edge cases (scores at boundary conditions)

---

## Issue #323: Test Issue ℹ️

This issue contains only the text "test" with no description. No action taken.

---

## Testing

### Manual Testing

#### Rate Limiting (Issue #325)
```bash
# Test rate limiting with multiple requests
for i in {1..70}; do
  curl -X GET http://localhost:3001/api/v1/health
  echo "Request $i"
done

# Should see 429 after 60 requests within 60 seconds
# Verify only one 429 response, not duplicate rejections
```

#### Nonce Comparison (Issue #324)
```bash
# 1. Request challenge
curl -X POST http://localhost:3001/api/v1/auth/challenge \
  -H "Content-Type: application/json" \
  -d '{"walletAddress":"GCEXAMPLE..."}'

# 2. Sign the nonce with your Stellar wallet

# 3. Authenticate with slightly modified nonce (timing attack attempt)
# Should fail consistently regardless of nonce similarity
curl -X GET http://localhost:3001/api/v1/policy \
  -H "x-wallet-address: GCEXAMPLE..." \
  -H "x-wallet-message: <modified_nonce>" \
  -H "x-wallet-signature: <signature>"
```

### Automated Testing

```typescript
describe('Security Fixes', () => {
  describe('Issue #325: Rate Limiting', () => {
    it('should enforce Redis-backed rate limits', async () => {
      const requests = Array.from({ length: 70 }, () =>
        request(app.getHttpServer()).get('/api/v1/health')
      );
      
      const responses = await Promise.all(requests);
      const rateLimited = responses.filter(r => r.status === 429);
      
      expect(rateLimited.length).toBeGreaterThan(0);
      expect(rateLimited.length).toBeLessThan(15); // Not all should be limited
    });
  });

  describe('Issue #324: Nonce Timing Safety', () => {
    it('should use constant-time comparison for nonces', async () => {
      // Create challenge
      const challenge = await createChallenge('GCEXAMPLE...');
      
      // Measure timing for correct nonce
      const start1 = process.hrtime.bigint();
      await authenticateWithNonce(challenge.nonce);
      const time1 = process.hrtime.bigint() - start1;
      
      // Measure timing for incorrect nonce (similar prefix)
      const start2 = process.hrtime.bigint();
      await authenticateWithNonce(challenge.nonce.slice(0, -1) + 'X');
      const time2 = process.hrtime.bigint() - start2;
      
      // Timing difference should be negligible (< 1ms)
      const diff = Number(time1 > time2 ? time1 - time2 : time2 - time1);
      expect(diff).toBeLessThan(1_000_000); // 1ms in nanoseconds
    });
  });
});
```

---

## Security Impact Summary

| Issue | Severity | Status | Impact |
|-------|----------|--------|--------|
| #325 | Medium | **FIXED** | Eliminated false 429s, improved multi-instance reliability |
| #324 | Medium | **ALREADY FIXED** | Timing attack protection confirmed |
| #313 | Low | **ADVISORY** | Contract-level issue, backend validates inputs |
| #323 | None | **N/A** | Test issue only |

---

## Deployment Notes

### Before Deployment

1. **Verify Redis connectivity** - ThrottlerGuard now relies solely on Redis
2. **Test rate limiting** - Ensure 429s are properly enforced
3. **Monitor error rates** - Check for unexpected 429 spikes

### After Deployment

1. **Monitor rate limit metrics** - Should see consistent enforcement across instances
2. **Check memory usage** - Should decrease slightly (no in-memory Map)
3. **Verify auth security** - No timing attack vulnerabilities

### Rollback Plan

If issues arise with Redis-backed rate limiting:
1. Ensure `REDIS_URL` environment variable is set correctly
2. Check Redis server is accessible from all instances
3. If needed, temporarily increase rate limits in `app.module.ts`

---

## References

- Issue #313: https://github.com/Parashield-Protocol/parashield-backend/issues/313
- Issue #324: https://github.com/Parashield-Protocol/parashield-backend/issues/324
- Issue #325: https://github.com/Parashield-Protocol/parashield-backend/issues/325
- NestJS Throttler: https://docs.nestjs.com/security/rate-limiting
- Timing-safe comparison: https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b

---

*Last updated: 2026-08-25*
