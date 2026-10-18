import { Injectable } from '@nestjs/common';

/**
 * Maximum allowed distinct values per metric label before collapsing to 'other' (#709).
 * Prevents high-cardinality labels (wallet addresses, transaction IDs, UUIDs) from
 * exploding Prometheus registry memory usage.
 */
export const MAX_LABEL_CARDINALITY = 100;

const labelValuesSeen = new Map<string, Set<string>>();

/**
 * Bounds the cardinality of metric label values to prevent memory leaks (#709).
 */
export function sanitizeMetricLabelValue(labelName: string, value: string): string {
  if (!value) return 'unknown';

  // Sanitize UUIDs / hex hashes / wallet addresses directly to 'redacted_id'
  if (/^[a-fA-F0-9-]{36}$/.test(value) || /^G[A-Z2-7]{55}$/.test(value)) {
    return 'redacted_id';
  }

  let seen = labelValuesSeen.get(labelName);
  if (!seen) {
    seen = new Set<string>();
    labelValuesSeen.set(labelName, seen);
  }

  if (seen.has(value)) {
    return value;
  }

  if (seen.size >= MAX_LABEL_CARDINALITY) {
    return 'other';
  }

  seen.add(value);
  return value;
}

@Injectable()
export class MetricsService {
  /**
   * Sanitizes a metric label set before recording to Prometheus.
   */
  sanitizeLabels(labels: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) {
      sanitized[key] = sanitizeMetricLabelValue(key, value);
    }
    return sanitized;
  }
}
