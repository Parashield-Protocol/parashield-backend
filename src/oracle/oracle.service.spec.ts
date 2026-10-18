import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { OracleService } from "./oracle.service";
import { PrismaService } from "../prisma/prisma.service";
import axios from "axios";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("OracleService.fetchRainfall", () => {
  let service: OracleService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === "AVIATIONSTACK_API_KEY") return undefined;
      if (key === "ORACLE_BATCH_SIZE") return "1";
      return undefined;
    }),
  };

  const mockPrismaService = {
    $transaction: jest.fn(async (arg: any) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      if (typeof arg === "function") {
        return arg(mockPrismaService);
      }
      return arg;
    }),
    oracleReading: {
      create: jest.fn().mockResolvedValue({ id: "mock-id" }),
      upsert: jest.fn().mockResolvedValue({ id: "mock-id" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OracleService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<OracleService>(OracleService);
    jest.clearAllMocks();

    // Mock axios.get to return synthetic precipitation data
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        daily: {
          precipitation_sum: [10.5, 20.3, 15.0],
        },
      },
    });
  });

  it("should sum rainfall values correctly (10.5 + 20.3 + 15.0 = 45.8)", async () => {
    // Mock persistReading
    mockPrismaService.oracleReading.upsert.mockResolvedValue({ id: "r1" });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    const totalMmFromValue = Number(reading.value) / 1e7;
    expect(totalMmFromValue).toBeCloseTo(45.8, 1);
  });

  it("should convert total rainfall to 7-decimal fixed point (45.8mm → 458000000n)", async () => {
    mockPrismaService.oracleReading.upsert.mockResolvedValue({ id: "r1" });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    expect(reading.value).toBe(String(BigInt(Math.round(45.8 * 1e7))));
    expect(reading.value).toBe("458000000");
  });

  it('should set source to "open-meteo"', async () => {
    mockPrismaService.oracleReading.upsert.mockResolvedValue({ id: "r1" });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    expect(reading.source).toBe("open-meteo");
  });

  it('should set dataType to "weather"', async () => {
    mockPrismaService.oracleReading.upsert.mockResolvedValue({ id: "r1" });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    expect(reading.dataType).toBe("weather");
  });

  it("should include lat/lng and date in the key", async () => {
    mockPrismaService.oracleReading.upsert.mockResolvedValue({ id: "r1" });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    expect(reading.key).toContain("rainfall");
    expect(reading.key).toContain("-0.0917");
    expect(reading.key).toContain("34.7679");
    expect(reading.key).toContain("2026-06");
  });

  it("should persist the reading to the database", async () => {
    mockPrismaService.oracleReading.upsert.mockResolvedValue({ id: "r1" });

    await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    expect(mockPrismaService.oracleReading.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrismaService.oracleReading.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          dataType: "weather",
          source: "open-meteo",
        }),
      }),
    );
  });

  it("should fetch rainfall without persisting when requested by the worker", async () => {
    const reading = await service.fetchRainfallReading(
      -0.0917,
      34.7679,
      2026,
      6,
    );

    expect(reading.key).toContain("rainfall");
    expect(mockPrismaService.oracleReading.upsert).not.toHaveBeenCalled();
  });

  it("should filter out null values in precipitation array", async () => {
    // Return array with null values mixed in
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        daily: {
          precipitation_sum: [10.5, null, 15.0, null, 20.3],
        },
      },
    });
    mockPrismaService.oracleReading.upsert.mockResolvedValue({ id: "r1" });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    // Should still sum 10.5 + 15.0 + 20.3 = 45.8
    expect(reading.value).toBe("458000000");
  });

  describe("fetchRainfallReading — only observed days (issue #73)", () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-06-28T12:00:00Z"));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should use /archive endpoint for past months", async () => {
      // Request May 2026 (before June 28, 2026 "today")
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [10.0, 20.0, 15.0],
            time: ["2026-05-01", "2026-05-02", "2026-05-03"],
          },
        },
      });

      await service.fetchRainfallReading(-0.0917, 34.7679, 2026, 5);

      const callUrl = (mockedAxios.get as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain("/archive");
    });

    it("should use /forecast endpoint for current month", async () => {
      // Request June 2026 (current month on June 28, 2026)
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [10.0, 20.0, 15.0],
            time: ["2026-06-01", "2026-06-02", "2026-06-03"],
          },
        },
      });

      await service.fetchRainfallReading(-0.0917, 34.7679, 2026, 6);

      const callUrl = (mockedAxios.get as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain("/forecast");
    });

    it("should filter out future days when using /forecast endpoint", async () => {
      // Simulate current month with both observed and future days
      // Today is June 28, 2026 (in the test environment)
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [10.0, 20.0, 15.0, 25.0, 30.0],
            time: [
              "2026-06-26",
              "2026-06-27",
              "2026-06-28",
              "2026-06-29",
              "2026-06-30",
            ],
          },
        },
      });

      const reading = await service.fetchRainfallReading(
        -0.0917,
        34.7679,
        2026,
        6,
      );

      // Only June 26-28 are observed (June 29-30 are future)
      // Sum = 10.0 + 20.0 + 15.0 = 45.0
      const totalMm = Number(reading.value) / 1e7;
      expect(totalMm).toBeCloseTo(45.0, 1);
    });

    it("should calculate confidence based only on observed days", async () => {
      // 3 observed days out of 30 days in June
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [10.0, 20.0, 15.0, null, null],
            time: [
              "2026-06-26",
              "2026-06-27",
              "2026-06-28",
              "2026-06-29",
              "2026-06-30",
            ],
          },
        },
      });

      const reading = await service.fetchRainfallReading(
        -0.0917,
        34.7679,
        2026,
        6,
      );

      // 3 observed days / 30 days in June = 0.1 coverage = 9.5% confidence (rounded)
      // Confidence = Math.round(0.1 * 95) = 9 or 10
      expect(reading.confidence).toBe(10);
    });

    it("should handle all future days (confidence = 0)", async () => {
      // All days are in the future
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [10.0, 20.0, 15.0, 25.0, 30.0],
            time: [
              "2026-07-01",
              "2026-07-02",
              "2026-07-03",
              "2026-07-04",
              "2026-07-05",
            ],
          },
        },
      });

      const reading = await service.fetchRainfallReading(
        -0.0917,
        34.7679,
        2026,
        7,
      );

      // No observed days
      expect(reading.value).toBe("0");
      expect(reading.confidence).toBe(0);
    });

    it("should include all days for past months via /archive endpoint", async () => {
      // Past month (May) - all data is observed
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [10.0, 20.0, 15.0, 25.0, 30.0],
            time: [
              "2026-05-01",
              "2026-05-02",
              "2026-05-03",
              "2026-05-04",
              "2026-05-05",
            ],
          },
        },
      });

      const reading = await service.fetchRainfallReading(
        -0.0917,
        34.7679,
        2026,
        5,
      );

      // All 5 days included: 10 + 20 + 15 + 25 + 30 = 100
      const totalMm = Number(reading.value) / 1e7;
      expect(totalMm).toBeCloseTo(100.0, 1);

      // 5 days out of 31 days in May = ~16% coverage
      expect(reading.confidence).toBeGreaterThan(0);
    });

    it("should handle mixed null and real values with date filtering", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [10.0, null, 15.0, 25.0, null],
            time: [
              "2026-06-26",
              "2026-06-27",
              "2026-06-28",
              "2026-06-29",
              "2026-06-30",
            ],
          },
        },
      });

      const reading = await service.fetchRainfallReading(
        -0.0917,
        34.7679,
        2026,
        6,
      );

      // Only June 26-28 are observed (date <= today)
      // June 26: 10.0, June 27: null (skip), June 28: 15.0
      // Sum = 10.0 + 15.0 = 25.0
      const totalMm = Number(reading.value) / 1e7;
      expect(totalMm).toBeCloseTo(25.0, 1);
    });

    it("should handle missing time array gracefully (assume all observed)", async () => {
      // No time array provided - should treat all non-null values as observed
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [10.5, 20.3, 15.0],
            // No time array
          },
        },
      });

      const reading = await service.fetchRainfallReading(
        -0.0917,
        34.7679,
        2026,
        5,
      );

      // Without dates, all non-null values are included: 10.5 + 20.3 + 15.0 = 45.8
      const totalMm = Number(reading.value) / 1e7;
      expect(totalMm).toBeCloseTo(45.8, 1);
    });
  });

  describe("fetchTemperatureReading — archive endpoint fix (#157)", () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-06-28T12:00:00Z"));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("should use /archive endpoint for past months", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            temperature_2m_max: [28.0, 30.0, 27.5],
            time: ["2026-05-01", "2026-05-02", "2026-05-03"],
          },
        },
      });

      await service.fetchTemperatureReading(-0.0917, 34.7679, 2026, 5);

      const callUrl = (mockedAxios.get as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain("/archive");
      expect(callUrl).not.toContain("/forecast");
    });

    it("should use /forecast endpoint for the current month", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            temperature_2m_max: [28.0, 30.0, 27.5],
            time: ["2026-06-01", "2026-06-02", "2026-06-03"],
          },
        },
      });

      await service.fetchTemperatureReading(-0.0917, 34.7679, 2026, 6);

      const callUrl = (mockedAxios.get as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain("/forecast");
      expect(callUrl).not.toContain("/archive");
    });

    it("should filter out future days when using /forecast endpoint", async () => {
      // Today is June 28 — June 29 and June 30 are future, should be excluded
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            temperature_2m_max: [25.0, 26.0, 27.0, 35.0, 36.0],
            time: ["2026-06-26", "2026-06-27", "2026-06-28", "2026-06-29", "2026-06-30"],
          },
        },
      });

      const reading = await service.fetchTemperatureReading(-0.0917, 34.7679, 2026, 6);

      // Only June 26-28 are observed: avg = (25 + 26 + 27) / 3 = 26.0
      const avgTempFromValue = Number(reading.value) / 1e7;
      expect(avgTempFromValue).toBeCloseTo(26.0, 1);
    });

    it("should include all days for past months (all observed via /archive)", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            temperature_2m_max: [20.0, 22.0, 24.0, 26.0, 28.0],
            time: ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"],
          },
        },
      });

      const reading = await service.fetchTemperatureReading(-0.0917, 34.7679, 2026, 5);

      // avg = (20 + 22 + 24 + 26 + 28) / 5 = 24.0
      const avgTempFromValue = Number(reading.value) / 1e7;
      expect(avgTempFromValue).toBeCloseTo(24.0, 1);
    });

    it("should return confidence = 0 when all days are future", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            temperature_2m_max: [30.0, 31.0, 32.0],
            time: ["2026-07-01", "2026-07-02", "2026-07-03"],
          },
        },
      });

      const reading = await service.fetchTemperatureReading(-0.0917, 34.7679, 2026, 7);

      expect(reading.value).toBe("0");
      expect(reading.confidence).toBe(0);
    });
  });

  describe("fetchFlightDelay and persistReading", () => {
    it("should throw ServiceUnavailableException if API key is not configured", async () => {
      mockConfigService.get.mockReturnValue(undefined);
      await expect(
        service.fetchFlightDelay("KQ100", "2026-06-27"),
      ).rejects.toThrow(/AviationStack API is not configured/);
    });

    it("should query AviationStack and persist if API key is configured", async () => {
      mockConfigService.get.mockImplementation((key) => {
        if (key === "AVIATIONSTACK_API_KEY") return "test-key";
        return undefined;
      });
      mockedAxios.get.mockResolvedValue({
        data: {
          data: [{ departure: { delay: 15 } }],
        },
      });
      mockPrismaService.oracleReading.upsert.mockResolvedValue({ id: "f1" });

      const reading = await service.fetchFlightDelay("KQ100", "2026-06-27");
      expect(reading.value).toBe("150000000");
      expect(reading.confidence).toBe(95);
      expect(reading.source).toBe("aviationstack");
      expect(mockPrismaService.oracleReading.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            dataType: "flight",
            key: "flight:KQ100:2026-06-27",
            value: BigInt("150000000"),
            confidence: 95,
            source: "aviationstack",
          }),
        }),
      );
    });

    it("should return NO_DATA with confidence 0 when AviationStack returns an empty result (#171)", async () => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
      mockedAxios.get.mockResolvedValue({ data: { data: [] } });

      const reading = await service.fetchFlightDelayReading(
        "KQ100",
        "2026-06-27",
      );

      expect(reading.status).toBe("NO_DATA");
      expect(reading.confidence).toBe(0);
    });

    it("should return NO_DATA when the flight exists but the delay is null (#171)", async () => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
      mockedAxios.get.mockResolvedValue({
        data: { data: [{ departure: { delay: null } }] },
      });

      const reading = await service.fetchFlightDelayReading(
        "KQ100",
        "2026-06-27",
      );

      expect(reading.status).toBe("NO_DATA");
      expect(reading.confidence).toBe(0);
    });

    it("should keep confidence 95 for a genuine 0-minute delay (#171)", async () => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
      mockedAxios.get.mockResolvedValue({
        data: { data: [{ departure: { delay: 0 } }] },
      });

      const reading = await service.fetchFlightDelayReading(
        "KQ100",
        "2026-06-27",
      );

      expect(reading.status).toBe("OK");
      expect(reading.confidence).toBe(95);
      expect(reading.value).toBe("0");
    });

    it("should never persist a NO_DATA reading (#171)", async () => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
      mockedAxios.get.mockResolvedValue({ data: { data: [] } });

      await service.fetchFlightDelay("KQ100", "2026-06-27");
      expect(mockPrismaService.oracleReading.upsert).not.toHaveBeenCalled();
    });

    it("should skip DB persistence if reading confidence is 0 or source is mock", async () => {
      const mockReading = {
        dataType: "flight",
        key: "flight:KQ100:2026-06-27",
        value: "0",
        confidence: 0,
        timestamp: 123456,
        source: "mock",
      };
      await service.persistReading(mockReading);
      expect(mockPrismaService.oracleReading.upsert).not.toHaveBeenCalled();
    });

    // #703 — reject future-dated readings
    it("should reject readings with future timestamps (#703)", async () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future
      const mockReading = {
        dataType: "weather",
        key: "rainfall:0,0:2026-06",
        value: "100000000",
        confidence: 95,
        timestamp: futureTimestamp,
        source: "open-meteo",
      };
      await expect(service.persistReading(mockReading)).rejects.toThrow(
        /future/i,
      );
      expect(mockPrismaService.oracleReading.upsert).not.toHaveBeenCalled();
    });

    it("should accept readings within clock skew tolerance (#703)", async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const mockReading = {
        dataType: "weather",
        key: "rainfall:0,0:2026-06",
        value: "100000000",
        confidence: 95,
        timestamp: nowSeconds + 30, // 30s ahead — within 60s tolerance
        source: "open-meteo",
      };
      await service.persistReading(mockReading);
      expect(mockPrismaService.oracleReading.upsert).toHaveBeenCalled();
    });

    it("#171 — returns NO_DATA when data array element is null", async () => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
      mockedAxios.get.mockResolvedValue({
        data: { data: [null] },
      });

      const reading = await service.fetchFlightDelayReading("KQ100", "2026-06-27");
      expect(reading.status).toBe("NO_DATA");
      expect(reading.confidence).toBe(0);
    });

    it("#171 — returns NO_DATA when the element has no departure field", async () => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
      mockedAxios.get.mockResolvedValue({
        data: { data: [{}] },
      });

      const reading = await service.fetchFlightDelayReading("KQ100", "2026-06-27");
      expect(reading.status).toBe("NO_DATA");
      expect(reading.confidence).toBe(0);
    });

    it("#171 — returns NO_DATA when departure is null", async () => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
      mockedAxios.get.mockResolvedValue({
        data: { data: [{ departure: null }] },
      });

      const reading = await service.fetchFlightDelayReading("KQ100", "2026-06-27");
      expect(reading.status).toBe("NO_DATA");
      expect(reading.confidence).toBe(0);
    });

    it("#171 — returns NO_DATA when departure exists but has no delay field", async () => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
      mockedAxios.get.mockResolvedValue({
        data: { data: [{ departure: {} }] },
      });

      const reading = await service.fetchFlightDelayReading("KQ100", "2026-06-27");
      expect(reading.status).toBe("NO_DATA");
      expect(reading.confidence).toBe(0);
    });

    it("#171 — returns NO_DATA when the top-level response has no data field", async () => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
      mockedAxios.get.mockResolvedValue({ data: {} });

      const reading = await service.fetchFlightDelayReading("KQ100", "2026-06-27");
      expect(reading.status).toBe("NO_DATA");
      expect(reading.confidence).toBe(0);
    });

    it("#171 — does not persist NO_DATA from a malformed response (null element)", async () => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
      mockedAxios.get.mockResolvedValue({
        data: { data: [null] },
      });

      await service.fetchFlightDelay("KQ100", "2026-06-27");
      expect(mockPrismaService.oracleReading.upsert).not.toHaveBeenCalled();
    });
  });

  describe("sanity bounds on upstream values (#173)", () => {
    beforeEach(() => {
      mockConfigService.get.mockImplementation((key) =>
        key === "AVIATIONSTACK_API_KEY" ? "test-key" : undefined,
      );
    });

    it("rejects negative rainfall as a fetch failure", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [10.0, -5.0],
            time: ["2026-05-01", "2026-05-02"],
          },
        },
      });

      await expect(
        service.fetchRainfallReading(-0.0917, 34.7679, 2026, 5),
      ).rejects.toThrow(/outside the plausible range/);
      expect(mockPrismaService.oracleReading.upsert).not.toHaveBeenCalled();
    });

    it("rejects an absurd rainfall total as a fetch failure", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [999_999],
            time: ["2026-05-01"],
          },
        },
      });

      await expect(
        service.fetchRainfallReading(-0.0917, 34.7679, 2026, 5),
      ).rejects.toThrow(/outside the plausible range/);
    });

    it("accepts a valid rainfall edge value of exactly 0", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            precipitation_sum: [0, 0],
            time: ["2026-05-01", "2026-05-02"],
          },
        },
      });

      const reading = await service.fetchRainfallReading(
        -0.0917,
        34.7679,
        2026,
        5,
      );
      expect(reading.value).toBe("0");
    });

    it("rejects physically impossible temperatures", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            temperature_2m_max: [25.0, 500.0],
            time: ["2026-05-01", "2026-05-02"],
          },
        },
      });

      await expect(
        service.fetchTemperatureReading(-0.0917, 34.7679, 2026, 5),
      ).rejects.toThrow(/outside the plausible range/);
    });

    it("accepts temperatures at the boundary of the allowed range", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          daily: {
            temperature_2m_max: [-100, 100],
            time: ["2026-05-01", "2026-05-02"],
          },
        },
      });

      const reading = await service.fetchTemperatureReading(
        -0.0917,
        34.7679,
        2026,
        5,
      );
      expect(reading.value).toBe("0");
    });

    it("rejects a negative flight delay", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: { data: [{ departure: { delay: -30 } }] },
      });

      await expect(
        service.fetchFlightDelayReading("KQ100", "2026-06-27"),
      ).rejects.toThrow(/outside the plausible range/);
    });

    it("rejects an implausibly large flight delay", async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: { data: [{ departure: { delay: 1_000_000 } }] },
      });

      await expect(
        service.fetchFlightDelayReading("KQ100", "2026-06-27"),
      ).rejects.toThrow(/outside the plausible range/);
    });
  });

  describe("bucketed idempotency (#172)", () => {
    const reading = {
      dataType: "flight",
      key: "flight:KQ100:2026-06-27",
      value: "150000000",
      confidence: 95,
      // 2026-06-27T10:42:30Z
      timestamp: Math.floor(Date.parse("2026-06-27T10:42:30Z") / 1000),
      source: "aviationstack",
    };

    it("truncates timestamps to the start of the hourly bucket", () => {
      expect(service.bucketStartFor(reading.timestamp).toISOString()).toBe(
        "2026-06-27T10:00:00.000Z",
      );
    });

    it("maps two readings in the same hour onto the same bucket", () => {
      const later = reading.timestamp + 900; // +15 minutes
      expect(service.bucketStartFor(later).getTime()).toBe(
        service.bucketStartFor(reading.timestamp).getTime(),
      );
    });

    it("places a float timestamp just below a boundary in the earlier bucket (#521)", () => {
      // 2026-06-27T11:00:00.000Z is exactly a boundary; subtract a tiny float
      // fraction so the raw ms product is 1 ULP above the boundary — without
      // Math.trunc this would slip into the 11:00 bucket instead of 10:00.
      const boundarySeconds = Date.parse("2026-06-27T11:00:00.000Z") / 1000;
      const justBefore = boundarySeconds - 0.0001; // 10:59:59.9999
      expect(service.bucketStartFor(justBefore).toISOString()).toBe(
        "2026-06-27T10:00:00.000Z",
      );
    });

    it("places a float timestamp at the boundary in the new bucket (#521)", () => {
      const boundarySeconds = Date.parse("2026-06-27T11:00:00.000Z") / 1000;
      expect(service.bucketStartFor(boundarySeconds).toISOString()).toBe(
        "2026-06-27T11:00:00.000Z",
      );
    });

    it("upserts on (key, source, bucketStart) so a repeated cron run cannot insert twice", async () => {
      await service.persistReading(reading);
      await service.persistReading({ ...reading, timestamp: reading.timestamp + 900 });

      expect(mockPrismaService.oracleReading.upsert).toHaveBeenCalledTimes(2);
      const [first, second] = (
        mockPrismaService.oracleReading.upsert as jest.Mock
      ).mock.calls;
      expect(first[0].where).toEqual(second[0].where);
      expect(first[0].where.key_source_bucket).toEqual({
        key: reading.key,
        source: reading.source,
        bucketStart: new Date("2026-06-27T10:00:00.000Z"),
      });
    });

    it("grants the on-chain submission claim to exactly one caller", async () => {
      (mockPrismaService.oracleReading.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await expect(service.claimForOnChainSubmission(reading)).resolves.toBe(true);
      await expect(service.claimForOnChainSubmission(reading)).resolves.toBe(false);

      const claimWhere = (mockPrismaService.oracleReading.updateMany as jest.Mock)
        .mock.calls[0][0];
      expect(claimWhere.where.onChainSubmitted).toBe(false);
      expect(claimWhere.data).toEqual({ onChainSubmitted: true });
    });

    it("releases the claim so a failed submission can be retried next cycle", async () => {
      await service.releaseOnChainClaim(reading);

      const call = (mockPrismaService.oracleReading.updateMany as jest.Mock).mock
        .calls[0][0];
      expect(call.where.onChainTxHash).toBeNull();
      expect(call.data).toEqual({ onChainSubmitted: false });
    });

    it("records the transaction hash of a successful submission", async () => {
      await service.recordOnChainSubmission(reading, "tx-abc");

      const call = (mockPrismaService.oracleReading.updateMany as jest.Mock).mock
        .calls[0][0];
      expect(call.data).toEqual({ onChainTxHash: "tx-abc" });
    });
  });

  describe("Batch persistence and buffering (#686)", () => {
    let customPrisma: {
      $transaction: jest.Mock;
      oracleReading: { upsert: jest.Mock; updateMany: jest.Mock };
    };

    function createOracleReading(key: string, value = "10000000"): any {
      return {
        dataType: "weather",
        key,
        value,
        confidence: 95,
        timestamp: Math.floor(Date.now() / 1000) - 100,
        source: "open-meteo",
        status: "OK",
      };
    }

    beforeEach(() => {
      customPrisma = {
        $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
        oracleReading: {
          upsert: jest.fn().mockResolvedValue({ id: "mock-row" }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
    });

    it("honors default configuration when env vars are not set (batchSize=50, flushInterval=1000, maxBuffer=1000)", () => {
      const config = { get: jest.fn().mockReturnValue(undefined) };
      const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);
      expect(s.getBatchSize()).toBe(50);
      expect(s.getFlushIntervalMs()).toBe(1000);
      expect(s.getMaxBufferSize()).toBe(1000);
    });

    it("honors overridden configuration from environment variables", () => {
      const config = {
        get: jest.fn((key: string) => {
          if (key === "ORACLE_BATCH_SIZE") return "25";
          if (key === "ORACLE_FLUSH_INTERVAL_MS") return "500";
          if (key === "ORACLE_BUFFER_MAX_SIZE") return "2000";
          return undefined;
        }),
      };
      const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);
      expect(s.getBatchSize()).toBe(25);
      expect(s.getFlushIntervalMs()).toBe(500);
      expect(s.getMaxBufferSize()).toBe(2000);
    });

    it("rejects invalid configuration (out of bounds or non-integer)", () => {
      const invalidBatch = { get: jest.fn((k: string) => (k === "ORACLE_BATCH_SIZE" ? "0" : undefined)) };
      expect(() => new OracleService(invalidBatch as any, customPrisma as any, {} as any, {} as any)).toThrow(
        "ORACLE_BATCH_SIZE must be a positive integer between 1 and 1000",
      );

      const invalidInterval = { get: jest.fn((k: string) => (k === "ORACLE_FLUSH_INTERVAL_MS" ? "5" : undefined)) };
      expect(() => new OracleService(invalidInterval as any, customPrisma as any, {} as any, {} as any)).toThrow(
        "ORACLE_FLUSH_INTERVAL_MS must be an integer between 10 and 60000",
      );

      const invalidBuffer = { get: jest.fn((k: string) => (k === "ORACLE_BUFFER_MAX_SIZE" ? "5" : undefined)) };
      expect(() => new OracleService(invalidBuffer as any, customPrisma as any, {} as any, {} as any)).toThrow(
        "ORACLE_BUFFER_MAX_SIZE must be an integer between 10 and 10000",
      );
    });

    it("persistReadings: N readings produce ceil(N / batchSize) database calls and respects batch size", async () => {
      const config = { get: jest.fn((k: string) => (k === "ORACLE_BATCH_SIZE" ? "10" : undefined)) };
      const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);

      // N = 25 with batchSize = 10 should produce ceil(25 / 10) = 3 $transaction calls
      const readings = Array.from({ length: 25 }, (_, i) => createOracleReading(`reading-${i}`));
      await s.persistReadings(readings);

      expect(customPrisma.$transaction).toHaveBeenCalledTimes(3);
      expect(customPrisma.$transaction.mock.calls[0][0]).toHaveLength(10);
      expect(customPrisma.$transaction.mock.calls[1][0]).toHaveLength(10);
      expect(customPrisma.$transaction.mock.calls[2][0]).toHaveLength(5);
    });

    it("persistReadings: empty batch makes no database calls", async () => {
      const config = { get: jest.fn().mockReturnValue(undefined) };
      const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);

      await s.persistReadings([]);
      expect(customPrisma.$transaction).not.toHaveBeenCalled();
      expect(customPrisma.oracleReading.upsert).not.toHaveBeenCalled();
    });

    it("buffer flushes on reaching batchSize", async () => {
      const config = { get: jest.fn((k: string) => (k === "ORACLE_BATCH_SIZE" ? "3" : undefined)) };
      const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);

      const p1 = s.persistReading(createOracleReading("key-1"));
      const p2 = s.persistReading(createOracleReading("key-2"));
      expect(customPrisma.$transaction).not.toHaveBeenCalled();
      expect(s.getBufferSize()).toBe(2);

      // Adding 3rd reading hits batchSize = 3 and triggers flush
      const p3 = s.persistReading(createOracleReading("key-3"));
      await Promise.all([p1, p2, p3]);

      expect(customPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(customPrisma.$transaction.mock.calls[0][0]).toHaveLength(3);
      expect(s.getBufferSize()).toBe(0);
    });

    it("buffer flushes on interval with fake timers", async () => {
      jest.useFakeTimers();
      try {
        const config = {
          get: jest.fn((k: string) => {
            if (k === "ORACLE_BATCH_SIZE") return "10";
            if (k === "ORACLE_FLUSH_INTERVAL_MS") return "500";
            return undefined;
          }),
        };
        const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);

        const p1 = s.persistReading(createOracleReading("key-timer-1"));
        const p2 = s.persistReading(createOracleReading("key-timer-2"));
        expect(customPrisma.$transaction).not.toHaveBeenCalled();
        expect(s.getBufferSize()).toBe(2);

        // Advance timers past flush interval
        jest.advanceTimersByTime(500);
        await Promise.all([p1, p2]);

        expect(customPrisma.$transaction).toHaveBeenCalledTimes(1);
        expect(customPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);
        expect(s.getBufferSize()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it("flushes remaining buffer on application shutdown", async () => {
      const config = { get: jest.fn((k: string) => (k === "ORACLE_BATCH_SIZE" ? "50" : undefined)) };
      const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);

      s.persistReading(createOracleReading("key-shutdown-1"));
      s.persistReading(createOracleReading("key-shutdown-2"));
      expect(s.getBufferSize()).toBe(2);
      expect(customPrisma.$transaction).not.toHaveBeenCalled();

      // Trigger shutdown hook
      await s.onApplicationShutdown("SIGTERM");

      expect(customPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(customPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);
      expect(s.getBufferSize()).toBe(0);
    });

    it("preserves upsert semantics on duplicates within same bucket", async () => {
      const config = { get: jest.fn((k: string) => (k === "ORACLE_BATCH_SIZE" ? "5" : undefined)) };
      const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);

      const fixedTimestamp = Math.floor(Date.now() / 1000) - 200;
      const readingA = { ...createOracleReading("dup-key", "100"), timestamp: fixedTimestamp };
      const readingB = { ...createOracleReading("dup-key", "200"), timestamp: fixedTimestamp };

      await s.persistReadings([readingA, readingB]);

      expect(customPrisma.$transaction).toHaveBeenCalledTimes(1);
      const ops = customPrisma.$transaction.mock.calls[0][0];
      expect(ops).toHaveLength(2);

      expect(customPrisma.oracleReading.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            key_source_bucket: {
              key: "dup-key",
              source: "open-meteo",
              bucketStart: s.bucketStartFor(fixedTimestamp),
            },
          },
          update: expect.objectContaining({ value: 100n }),
          create: expect.objectContaining({ value: 100n }),
        }),
      );
    });

    it("isolates failing row without losing remaining readings in batch", async () => {
      const config = { get: jest.fn((k: string) => (k === "ORACLE_BATCH_SIZE" ? "10" : undefined)) };
      const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);

      customPrisma.$transaction.mockRejectedValueOnce(new Error("Transaction collision"));

      customPrisma.oracleReading.upsert.mockImplementation((args: any) => {
        if (args.where.key_source_bucket.key === "key-bad") {
          return Promise.reject(new Error("Constraint violation on key-bad"));
        }
        return Promise.resolve({ id: "row-ok" });
      });

      const pGood1 = s.persistReading(createOracleReading("key-good-1"));
      const pBad = s.persistReading(createOracleReading("key-bad"));
      const pGood2 = s.persistReading(createOracleReading("key-good-2"));

      await s.flushBuffer();

      await expect(pGood1).resolves.toBeUndefined();
      await expect(pGood2).resolves.toBeUndefined();
      await expect(pBad).rejects.toThrow("Constraint violation on key-bad");
    });

    it("preserves ordering of readings (FIFO)", async () => {
      const config = { get: jest.fn((k: string) => (k === "ORACLE_BATCH_SIZE" ? "3" : undefined)) };
      const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);

      const p1 = s.persistReading(createOracleReading("order-1"));
      const p2 = s.persistReading(createOracleReading("order-2"));
      const p3 = s.persistReading(createOracleReading("order-3"));

      await Promise.all([p1, p2, p3]);

      const ops = customPrisma.$transaction.mock.calls[0][0];
      expect(ops).toHaveLength(3);
      expect(customPrisma.oracleReading.upsert.mock.calls[0][0].where.key_source_bucket.key).toBe("order-1");
      expect(customPrisma.oracleReading.upsert.mock.calls[1][0].where.key_source_bucket.key).toBe("order-2");
      expect(customPrisma.oracleReading.upsert.mock.calls[2][0].where.key_source_bucket.key).toBe("order-3");
    });

    it("applies backpressure when buffer reaches maxBufferSize", async () => {
      const config = {
        get: jest.fn((k: string) => {
          if (k === "ORACLE_BATCH_SIZE") return "100";
          if (k === "ORACLE_BUFFER_MAX_SIZE") return "2";
          return undefined;
        }),
      };
      const s = new OracleService(config as any, customPrisma as any, {} as any, {} as any);

      s.persistReading(createOracleReading("k1"));
      s.persistReading(createOracleReading("k2"));

      await expect(s.persistReading(createOracleReading("k3"))).rejects.toThrow(
        "Oracle reading buffer full; backpressure applied",
      );
    });
  });
});
