import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OracleService } from './oracle.service';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('OracleService.fetchRainfall', () => {
  let service: OracleService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'AVIATIONSTACK_API_KEY') return undefined;
      return undefined;
    }),
  };

  const mockPrismaService = {
    oracleReading: {
      create:    jest.fn().mockResolvedValue({ id: 'mock-id' }),
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

  it('should sum rainfall values correctly (10.5 + 20.3 + 15.0 = 45.8)', async () => {
    // Mock persistReading
    mockPrismaService.oracleReading.create.mockResolvedValue({ id: 'r1' });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    const totalMmFromValue = Number(reading.value) / 1e7;
    expect(totalMmFromValue).toBeCloseTo(45.8, 1);
  });

  it('should convert total rainfall to 7-decimal fixed point (45.8mm → 458000000n)', async () => {
    mockPrismaService.oracleReading.create.mockResolvedValue({ id: 'r1' });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    expect(reading.value).toBe(BigInt(Math.round(45.8 * 1e7)));
    expect(reading.value).toBe(458000000n);
  });

  it('should set source to "open-meteo"', async () => {
    mockPrismaService.oracleReading.create.mockResolvedValue({ id: 'r1' });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    expect(reading.source).toBe('open-meteo');
  });

  it('should set dataType to "weather"', async () => {
    mockPrismaService.oracleReading.create.mockResolvedValue({ id: 'r1' });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    expect(reading.dataType).toBe('weather');
  });

  it('should include lat/lng and date in the key', async () => {
    mockPrismaService.oracleReading.create.mockResolvedValue({ id: 'r1' });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    expect(reading.key).toContain('rainfall');
    expect(reading.key).toContain('-0.0917');
    expect(reading.key).toContain('34.7679');
    expect(reading.key).toContain('2026-06');
  });

  it('should persist the reading to the database', async () => {
    mockPrismaService.oracleReading.create.mockResolvedValue({ id: 'r1' });

    await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    expect(mockPrismaService.oracleReading.create).toHaveBeenCalledTimes(1);
    expect(mockPrismaService.oracleReading.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dataType: 'weather',
          source:   'open-meteo',
        }),
      }),
    );
  });

  it('should filter out null values in precipitation array', async () => {
    // Return array with null values mixed in
    mockedAxios.get = jest.fn().mockResolvedValue({
      data: {
        daily: {
          precipitation_sum: [10.5, null, 15.0, null, 20.3],
        },
      },
    });
    mockPrismaService.oracleReading.create.mockResolvedValue({ id: 'r1' });

    const reading = await service.fetchRainfall(-0.0917, 34.7679, 2026, 6);
    // Should still sum 10.5 + 15.0 + 20.3 = 45.8
    expect(reading.value).toBe(458000000n);
  });
});
