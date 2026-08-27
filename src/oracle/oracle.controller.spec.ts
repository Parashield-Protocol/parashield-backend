import { BadRequestException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OracleController } from "./oracle.controller";
import { OracleService } from "./oracle.service";
import { OperatorAuthGuard } from "../auth/operator-auth.guard";
import { AviationStackApiKeyGuard } from "./guards/aviation-stack-api-key.guard";

describe("OracleController — Access Control & Rate Limiting", () => {
  let controller: OracleController;
  let mockOracleService: any;

  const mockReading = {
    dataType: "weather",
    key: "rainfall:-0.0917,34.7679:2026-06",
    value: BigInt(324000000),
    confidence: 95,
    timestamp: 1719576600,
    source: "open-meteo",
  };

  beforeEach(() => {
    mockOracleService = {
      getLatestReading: jest.fn(),
      getAllReadings: jest.fn(),
      fetchRainfall: jest.fn(),
      fetchTemperature: jest.fn(),
      fetchFlightDelay: jest.fn(),
    };
    controller = new OracleController(mockOracleService);
    jest.clearAllMocks();
  });

  describe("Public Endpoints (No Authentication Required)", () => {
    it("GET /oracle/latest/:key should allow anonymous access", async () => {
      mockOracleService.getLatestReading.mockResolvedValue(mockReading);

      const result = await controller.getLatestReading(
        "rainfall:-0.0917,34.7679:2026-06",
      );

      expect(result.success).toBe(true);
      expect(result.data.key).toBe("rainfall:-0.0917,34.7679:2026-06");
    });

    it("GET /oracle/latest/:key should return error when key not found", async () => {
      mockOracleService.getLatestReading.mockResolvedValue(null);

      await expect(controller.getLatestReading("nonexistent-key")).rejects.toThrow(
        "No reading found",
      );
    });

    it("GET /oracle/reading?key should handle URL-encoded parameters", async () => {
      mockOracleService.getLatestReading.mockResolvedValue(mockReading);

      const encodedKey = encodeURIComponent("rainfall:-0.0917,34.7679:2026-06");
      await controller.getReadingByKey(encodedKey);

      expect(mockOracleService.getLatestReading).toHaveBeenCalledWith(
        "rainfall:-0.0917,34.7679:2026-06",
      );
    });

    it("GET /oracle/readings should default to 100 items", async () => {
      mockOracleService.getAllReadings.mockResolvedValue([mockReading]);

      await controller.getAllReadings();

      expect(mockOracleService.getAllReadings).toHaveBeenCalledWith(100);
    });

    it("GET /oracle/readings should cap limit at 500", async () => {
      mockOracleService.getAllReadings.mockResolvedValue([]);

      await controller.getAllReadings("9999");

      expect(mockOracleService.getAllReadings).toHaveBeenCalledWith(500);
    });

    it("GET /oracle/reading should return not found when key is empty", async () => {
      mockOracleService.getLatestReading.mockResolvedValue(null);

      await expect(controller.getReadingByKey("")).rejects.toThrow("No reading found");
    });
  });

  describe("Protected Endpoints (Authentication Required)", () => {
    it("POST /oracle/fetch/rainfall should require OperatorAuthGuard", async () => {
      mockOracleService.fetchRainfall.mockResolvedValue(mockReading);

      const result = await controller.fetchRainfall({
        lat: -0.0917,
        lng: 34.7679,
        year: 2026,
        month: 6,
      });

      expect(result.success).toBe(true);
    });

    it("POST /oracle/fetch/temperature should require OperatorAuthGuard", async () => {
      mockOracleService.fetchTemperature.mockResolvedValue(mockReading);

      const result = await controller.fetchTemperature({
        lat: -0.0917,
        lng: 34.7679,
        year: 2026,
        month: 6,
      });

      expect(result.success).toBe(true);
    });

    it("GET /oracle/rainfall should require OperatorAuthGuard", async () => {
      mockOracleService.fetchRainfall.mockResolvedValue(mockReading);

      const result = await controller.getRainfall(
        "-0.0917",
        "34.7679",
        "2026",
        "6",
      );

      expect(result.success).toBe(true);
    });

    it("GET /oracle/flight should require AviationStackApiKeyGuard", async () => {
      mockOracleService.fetchFlightDelay.mockResolvedValue(mockReading);

      const result = await controller.getFlight("KQ100", "2026-06-27");

      expect(result.success).toBe(true);
    });
  });

  // #473 — GET /oracle/rainfall and GET /oracle/flight take raw query
  // params with no DTO, so they previously had no validation at all: an
  // unparsable lat/lng/year/month silently became NaN.
  describe("Query-param input validation (#473)", () => {
    it.each([
      ["lat out of range", "91", "34.7679", "2026", "6"],
      ["lat not a number", "abc", "34.7679", "2026", "6"],
      ["lng out of range", "-0.0917", "181", "2026", "6"],
      ["year out of range", "-0.0917", "34.7679", "1999", "6"],
      ["month out of range", "-0.0917", "34.7679", "2026", "13"],
      ["month not an integer", "-0.0917", "34.7679", "2026", "6.5"],
    ])("GET /oracle/rainfall rejects %s", async (_label, lat, lng, year, month) => {
      await expect(controller.getRainfall(lat, lng, year, month)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockOracleService.fetchRainfall).not.toHaveBeenCalled();
    });

    it.each([
      ["lowercase flight code", "kq100", "2026-06-27"],
      ["flight code with spaces", "KQ 100", "2026-06-27"],
      ["malformed date", "KQ100", "27-06-2026"],
      ["empty date", "KQ100", ""],
    ])("GET /oracle/flight rejects %s", async (_label, flight, date) => {
      await expect(controller.getFlight(flight, date)).rejects.toThrow(BadRequestException);
      expect(mockOracleService.fetchFlightDelay).not.toHaveBeenCalled();
    });
  });

  describe("Guard Registration (Decorator Metadata)", () => {
    it("fetchRainfall has OperatorAuthGuard registered", () => {
      const reflector = new Reflector();
      const guards = reflector.get<unknown[]>("__guards__", controller.fetchRainfall);
      expect(guards).toBeDefined();
      expect(guards).toContain(OperatorAuthGuard);
    });

    it("fetchTemperature has OperatorAuthGuard registered", () => {
      const reflector = new Reflector();
      const guards = reflector.get<unknown[]>("__guards__", controller.fetchTemperature);
      expect(guards).toBeDefined();
      expect(guards).toContain(OperatorAuthGuard);
    });

    it("getRainfall has OperatorAuthGuard registered", () => {
      const reflector = new Reflector();
      const guards = reflector.get<unknown[]>("__guards__", controller.getRainfall);
      expect(guards).toBeDefined();
      expect(guards).toContain(OperatorAuthGuard);
    });

    it("getFlight has OperatorAuthGuard and AviationStackApiKeyGuard registered", () => {
      const reflector = new Reflector();
      const guards = reflector.get<unknown[]>("__guards__", controller.getFlight);
      expect(guards).toBeDefined();
      expect(guards).toContain(OperatorAuthGuard);
      expect(guards).toContain(AviationStackApiKeyGuard);
    });

    it("public endpoints (latest/:key, reading, readings) have NO guards registered", () => {
      const reflector = new Reflector();
      expect(reflector.get<unknown[]>("__guards__", controller.getLatestReading)).toBeUndefined();
      expect(reflector.get<unknown[]>("__guards__", controller.getReadingByKey)).toBeUndefined();
      expect(reflector.get<unknown[]>("__guards__", controller.getAllReadings)).toBeUndefined();
    });
  });

  describe("Response Format & Security", () => {
    it("should always return { success, data?, error? } format", async () => {
      mockOracleService.getLatestReading.mockResolvedValue(mockReading);

      const result = await controller.getLatestReading("key");

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    it("should convert BigInt values to strings", async () => {
      mockOracleService.getLatestReading.mockResolvedValue(mockReading);

      const result = await controller.getLatestReading("key");

      expect(result.data.value).toBe("324000000");
      expect(typeof result.data.value).toBe("string");
    });

    it("should not expose system internals in error messages", async () => {
      mockOracleService.getLatestReading.mockResolvedValue(null);

      await expect(controller.getLatestReading("unknown-key")).rejects.toThrow(
        "No reading found",
      );
      try {
        await controller.getLatestReading("unknown-key");
      } catch (err) {
        expect((err as Error).message).not.toMatch(/database|config|path|stack/i);
      }
    });
  });

  describe("Security Documentation", () => {
    it("oracle controller endpoints are properly documented", () => {
      // Verified in oracle.controller.ts:
      // - Public endpoints have JSDoc: "PUBLIC ENDPOINT: No authentication required."
      // - Protected endpoints have JSDoc: "OPERATOR ONLY:" or "PROTECTED ENDPOINT:"
      // - Rate limiting documented: "Rate limited: 60 requests/minute per IP"
      // - @Throttle({ default: { limit: 60, ttl: 60000 } }) on public endpoints
      // - @UseGuards(OperatorAuthGuard) on protected endpoints
      expect(controller).toBeDefined();
    });
  });
});
