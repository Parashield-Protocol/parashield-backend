/**
 * #473 — canonical oracle key formats, shared by the format-validation
 * middleware and anything else that needs to recognize a well-formed key.
 *
 * These mirror exactly what OracleService ever writes (see fetchRainfallReading,
 * fetchTemperatureReading, fetchFlightDelayReading in oracle.service.ts):
 *   rainfall:<lat>,<lng>:YYYY-MM
 *   temperature:<lat>,<lng>:YYYY-MM
 *   flight:<FLIGHT_CODE>:YYYY-MM-DD
 *
 * (policy.service.ts's validateOracleKey enforces the same rainfall/flight
 * shapes independently, scoped to the buy-policy flow; this module covers
 * the oracle read/fetch endpoints, including temperature which isn't yet a
 * purchasable product category.)
 */
const RAINFALL_OR_TEMPERATURE_KEY_RE =
  /^(?:rainfall|temperature):(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?):20\d{2}-(?:0[1-9]|1[0-2])$/;
const FLIGHT_KEY_RE = /^flight:[A-Z0-9]+:20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/**
 * Range-checks the lat/lng embedded in a rainfall/temperature key in addition
 * to the format regex, which only checks that they're signed decimals — same
 * reasoning as IsValidOracleKeyCoordinates in
 * src/policy/dto/oracle-key-coordinates.validator.ts.
 */
export function isValidOracleKeyFormat(key: string): boolean {
  const coordMatch = RAINFALL_OR_TEMPERATURE_KEY_RE.exec(key);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lng = parseFloat(coordMatch[2]);
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }
  return FLIGHT_KEY_RE.test(key);
}

export const ORACLE_KEY_FORMAT_DESCRIPTION =
  'rainfall:<lat>,<lng>:YYYY-MM, temperature:<lat>,<lng>:YYYY-MM, or flight:<code>:YYYY-MM-DD';
