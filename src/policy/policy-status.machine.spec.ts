import { BadRequestException } from '@nestjs/common';
import { transition, canTransition } from './policy-status.machine';

describe('PolicyStatusMachine', () => {
  describe('canTransition', () => {
    it('should allow ACTIVE -> EXPIRED', () => {
      expect(canTransition('ACTIVE', 'EXPIRED')).toBe(true);
    });

    it('should allow ACTIVE -> CLAIMED', () => {
      expect(canTransition('ACTIVE', 'CLAIMED')).toBe(true);
    });

    it('should allow ACTIVE -> CANCELLED', () => {
      expect(canTransition('ACTIVE', 'CANCELLED')).toBe(true);
    });

    it('should not allow EXPIRED -> ACTIVE', () => {
      expect(canTransition('EXPIRED', 'ACTIVE')).toBe(false);
    });

    it('should not allow CLAIMED -> ACTIVE', () => {
      expect(canTransition('CLAIMED', 'ACTIVE')).toBe(false);
    });

    it('should not allow CANCELLED -> ACTIVE', () => {
      expect(canTransition('CANCELLED', 'ACTIVE')).toBe(false);
    });

    // #164/#166 — atomic claims-processing gate
    it('should allow ACTIVE -> PROCESSING', () => {
      expect(canTransition('ACTIVE', 'PROCESSING')).toBe(true);
    });

    it('should allow PROCESSING -> CLAIMED', () => {
      expect(canTransition('PROCESSING', 'CLAIMED')).toBe(true);
    });

    it('should allow PROCESSING -> ACTIVE (payout failure recovery, #165)', () => {
      expect(canTransition('PROCESSING', 'ACTIVE')).toBe(true);
    });

    it('should not allow PROCESSING -> EXPIRED or CANCELLED', () => {
      expect(canTransition('PROCESSING', 'EXPIRED')).toBe(false);
      expect(canTransition('PROCESSING', 'CANCELLED')).toBe(false);
    });
  });

  describe('transition', () => {
    it('should return the next status for valid transitions', () => {
      expect(transition('ACTIVE', 'EXPIRED')).toBe('EXPIRED');
    });

    it('should throw BadRequestException for invalid transitions', () => {
      expect(() => transition('EXPIRED', 'ACTIVE')).toThrow(BadRequestException);
    });
  });
});
