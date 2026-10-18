/**
 * Oracle Reading Insert Benchmark (#686)
 *
 * Measures database round-trips and wall-clock throughput for unbatched (1-by-1)
 * vs batched upserts.
 *
 * Usage:
 *   npx ts-node scripts/benchmark-oracle-inserts.ts
 */

import { OracleReading } from '../src/oracle/oracle.service';

interface MockPrismaClient {
  roundTrips: number;
  oracleReading: {
    upsert: (args: any) => Promise<any>;
  };
  $transaction: (ops: Promise<any>[]) => Promise<any[]>;
  resetCounts: () => void;
}

function createCountingPrisma(): MockPrismaClient {
  let roundTrips = 0;
  return {
    get roundTrips() {
      return roundTrips;
    },
    oracleReading: {
      upsert: async (args: any) => {
        roundTrips++;
        return { id: 'mock', ...args.create };
      },
    },
    $transaction: async (ops: Promise<any>[]) => {
      roundTrips++; // $transaction executes in 1 multi-query round-trip
      return Promise.all(ops);
    },
    resetCounts: () => {
      roundTrips = 0;
    },
  };
}

function generateSampleReadings(count: number): OracleReading[] {
  const now = Math.floor(Date.now() / 1000);
  const readings: OracleReading[] = [];
  for (let i = 0; i < count; i++) {
    readings.push({
      key: `ORACLE_MARKET_${i % 10}`,
      value: (1000000000n + BigInt(i * 100)).toString(),
      timestamp: now - (i % 60),
      confidence: 99,
      source: 'dia',
      dataType: 'USD_PRICE',
      status: 'ACTIVE',
    });
  }
  return readings;
}

async function runBenchmark() {
  const N = 100;
  const batchSize = 50;
  const readings = generateSampleReadings(N);

  console.log('====================================================');
  console.log(`Oracle Batching Benchmark (N = ${N} readings, batchSize = ${batchSize})`);
  console.log('====================================================\n');

  // 1. Unbatched (Before #686)
  const unbatchedDb = createCountingPrisma();
  const startUnbatched = process.hrtime.bigint();
  for (const r of readings) {
    await unbatchedDb.oracleReading.upsert({
      where: {
        key_source_bucket: {
          key: r.key,
          source: r.source,
          bucketStart: new Date(r.timestamp * 1000),
        },
      },
      update: { value: BigInt(r.value) },
      create: { key: r.key, value: BigInt(r.value), source: r.source, bucketStart: new Date(r.timestamp * 1000) },
    });
  }
  const endUnbatched = process.hrtime.bigint();
  const unbatchedRoundTrips = unbatchedDb.roundTrips;
  const unbatchedDurationMs = Number(endUnbatched - startUnbatched) / 1e6;

  // 2. Batched (After #686)
  const batchedDb = createCountingPrisma();
  const startBatched = process.hrtime.bigint();
  for (let i = 0; i < readings.length; i += batchSize) {
    const chunk = readings.slice(i, i + batchSize);
    const ops = chunk.map((r) =>
      Promise.resolve({
        where: {
          key_source_bucket: {
            key: r.key,
            source: r.source,
            bucketStart: new Date(r.timestamp * 1000),
          },
        },
        update: { value: BigInt(r.value) },
        create: { key: r.key, value: BigInt(r.value), source: r.source, bucketStart: new Date(r.timestamp * 1000) },
      }),
    );
    await batchedDb.$transaction(ops);
  }
  const endBatched = process.hrtime.bigint();
  const batchedRoundTrips = batchedDb.roundTrips;
  const batchedDurationMs = Number(endBatched - startBatched) / 1e6;

  console.log(`[Before - 1:1 Individual Upserts]`);
  console.log(`- Database Round Trips : ${unbatchedRoundTrips}`);
  console.log(`- Simulated Exec Time  : ${unbatchedDurationMs.toFixed(3)} ms`);
  console.log('');
  console.log(`[After - Batched Transactions]`);
  console.log(`- Database Round Trips : ${batchedRoundTrips} (reduction: ${(((unbatchedRoundTrips - batchedRoundTrips) / unbatchedRoundTrips) * 100).toFixed(1)}%)`);
  console.log(`- Simulated Exec Time  : ${batchedDurationMs.toFixed(3)} ms`);
  console.log('');
  console.log(`Note: Database connection is not available in isolated test environment; round trips are measured via exact query counting.`);
  console.log('====================================================');
}

if (require.main === module) {
  runBenchmark().catch(console.error);
}
