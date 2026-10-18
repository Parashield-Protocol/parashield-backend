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
