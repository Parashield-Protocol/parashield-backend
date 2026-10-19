import { nextPremiumRateVersion, snapshotPremiumRate } from './premium-rate-versioning';

describe('premium rate versioning', () => {
  it('increments the template version only when the rate changes', () => {
    const current = { premiumRate: 500, premiumRateVersion: 3 };
    expect(nextPremiumRateVersion(current, 650)).toBe(4);
    expect(nextPremiumRateVersion(current, 500)).toBe(3);
    expect(nextPremiumRateVersion(current, undefined)).toBe(3);
  });

  it('keeps a policy snapshot unchanged after a template update', () => {
    const product = { premiumRate: 500, premiumRateVersion: 1 };
    const policyRate = snapshotPremiumRate(product);

    product.premiumRate = 750;
    product.premiumRateVersion = nextPremiumRateVersion(policyRate, product.premiumRate);

    expect(policyRate).toEqual({ premiumRate: 500, premiumRateVersion: 1 });
    expect(product).toEqual({ premiumRate: 750, premiumRateVersion: 2 });
  });
});
