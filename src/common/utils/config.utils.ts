/**
 * Strict boolean environment variable parser (#706).
 *
 * Rejects arbitrary strings (e.g. "random_string", "2", "enabled") that JS Boolean()
 * would incorrectly evaluate as true.
 *
 * Valid truthy strings: "true", "1", "yes", "on"
 * Valid falsy strings: "false", "0", "no", "off"
 *
 * Throws an Error on invalid boolean configuration strings.
 */
export function parseBooleanEnv(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(trimmed)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(trimmed)) {
      return false;
    }
    throw new Error(`Invalid boolean configuration value: "${value}". Allowed values are true, false, 1, 0, yes, no, on, off.`);
  }

  throw new Error(`Invalid boolean configuration type: ${typeof value}`);
}

/**
 * Validate URL configuration at startup (#734).
 *
 * Rejects malformed URLs so the service fails fast with a clear error
 * instead of producing runtime failures from bad endpoint configuration.
 *
 * @param value - The URL string to validate
 * @param name - The configuration key name (for error messages)
 * @returns The validated URL string
 * @throws Error if the URL is not a valid http(s) URL
 */
export function validateUrlEnv(value: string | undefined, name: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required URL configuration: ${name}`);
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Invalid URL protocol for ${name}: "${value}". Must use http: or https:.`);
    }
    return value;
  } catch (err) {
    if (err instanceof Error && err.message.includes('Invalid URL protocol')) {
      throw err;
    }
    throw new Error(`Invalid URL configuration for ${name}: "${value}". Must be a valid http(s) URL.`);
  }
}

/**
 * Validate optional URL configuration (#734).
 *
 * Returns undefined if value is not set; validates format if it is.
 */
export function validateOptionalUrlEnv(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return validateUrlEnv(value, name);
}

/** Validate a TCP port and return its numeric value. */
export function validatePortEnv(value: unknown, name = 'PORT', defaultValue = 3001): number {
  const candidate = value === undefined || value === null || value === '' ? defaultValue : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return candidate;
}
