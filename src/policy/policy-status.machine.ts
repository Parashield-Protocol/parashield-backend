import { BadRequestException } from '@nestjs/common';

/**
 * PolicyStatus state machine.
 *
 * Defines valid status transitions for an insurance policy.
 * Prevents illegal state changes like re-activating an expired policy
 * or paying out a cancelled policy.
 *
 * Transition graph:
 *   ACTIVE → EXPIRED     (endTime passed without trigger)
 *   ACTIVE → CANCELLED   (policyholder cancels before expiry)
 *   ACTIVE → CLAIMED     (trigger met, payout executed)
 *   All terminal states → (no transitions allowed)
 */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  ACTIVE:    ['EXPIRED', 'CANCELLED', 'CLAIMED'],
  EXPIRED:   [],
  CANCELLED: [],
  CLAIMED:   [],
};

/**
 * Returns true if the transition from `from` to `to` is valid.
 */
export function canTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Perform a status transition.
 * Throws BadRequestException if the transition is invalid.
 *
 * @param current - The current status
 * @param next    - The target status
 * @returns       - The new status (same as `next`)
 */
export function transition(current: string, next: string): string {
  if (!canTransition(current, next)) {
    const allowed = VALID_TRANSITIONS[current] ?? [];
    throw new BadRequestException(
      `Invalid policy status transition: ${current} → ${next}. ` +
      `Allowed transitions from ${current}: [${allowed.join(', ') || 'none'}]`,
    );
  }
  return next;
}
