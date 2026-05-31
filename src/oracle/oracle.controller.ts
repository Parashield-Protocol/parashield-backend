import { Controller, Get, Query } from '@nestjs/common';
import { OracleService } from './oracle.service';

@Controller('oracle')
export class OracleController {
  constructor(private readonly oracle: OracleService) {}

  /** GET /api/v1/oracle/rainfall?lat=...&lng=...&year=...&month=... */
  @Get('rainfall')
  async getRainfall(
    @Query('lat')   lat:   string,
    @Query('lng')   lng:   string,
    @Query('year')  year:  string,
    @Query('month') month: string,
  ) {
    const reading = await this.oracle.fetchRainfall(
      parseFloat(lat),
      parseFloat(lng),
      parseInt(year),
      parseInt(month),
    );
    return { success: true, data: { ...reading, value: reading.value.toString() } };
  }

  /** GET /api/v1/oracle/flight?flight=KQ100&date=2026-06-15 */
  @Get('flight')
  async getFlight(
    @Query('flight') flight: string,
    @Query('date')   date:   string,
  ) {
    const reading = await this.oracle.fetchFlightDelay(flight, date);
    return { success: true, data: { ...reading, value: reading.value.toString() } };
  }
}
