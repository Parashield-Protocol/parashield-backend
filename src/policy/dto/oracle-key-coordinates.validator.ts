import { registerDecorator, ValidationOptions } from 'class-validator';

const RAINFALL_COORDS_RE = /^rainfall:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?):/;

/**
 * Range-checks the lat/lng embedded in a `rainfall:<lat>,<lng>:YYYY-MM` oracleKey.
 *
 * The format regex on `oracleKey` only checks that lat/lng are signed decimals —
 * it never bounds them, unlike `OracleFeedRequestDto`'s standalone lat/lng fields
 * (@Min(-90)/@Max(90), @Min(-180)/@Max(180)). Without this, an out-of-range key
 * like `rainfall:9999,9999:2026-06` passes DTO validation and is later re-parsed
 * by the same unbounded regex in oracle.worker.ts and sent straight to the
 * external weather API.
 */
export function IsValidOracleKeyCoordinates(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidOracleKeyCoordinates',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return true;
          const match = RAINFALL_COORDS_RE.exec(value);
          if (!match) return true; // not a rainfall key — nothing to range-check here
          const lat = parseFloat(match[1]);
          const lng = parseFloat(match[2]);
          return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
        },
        defaultMessage() {
          return 'oracleKey rainfall coordinates must be within lat [-90, 90] and lng [-180, 180]';
        },
      },
    });
  };
}
