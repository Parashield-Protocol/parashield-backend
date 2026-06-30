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
      return undefined;
    }),
  };

  const mockPrismaService = {
    oracleReading: {
      create: jest.fn().mockResolvedValue({ id: "mock-id" }),
      upsert: jest.fn().mockResolvedValue({ id: "mock-id" }),
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
      expect(mockPrismaService.oracleReading.upsert).toHaveBeenCalled();
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
  });
});
