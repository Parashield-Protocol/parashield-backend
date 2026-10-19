export interface PremiumRateTemplate {
  premiumRate: number;
  premiumRateVersion: number;
}

/** A template version changes only when its premium rate changes. */
export function nextPremiumRateVersion(
  current: PremiumRateTemplate,
  nextRate: number | undefined,
): number {
  return nextRate !== undefined && nextRate !== current.premiumRate
    ? current.premiumRateVersion + 1
    : current.premiumRateVersion;
}

/** Copy the rate fields so a policy never follows later product mutations. */
export function snapshotPremiumRate(template: PremiumRateTemplate): PremiumRateTemplate {
  return {
    premiumRate: template.premiumRate,
    premiumRateVersion: template.premiumRateVersion,
  };
}
