const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // 1. Seed initial Product
  const existingProduct = await prisma.product.findUnique({
    where: { id: '1' },
  });

  if (!existingProduct) {
    await prisma.product.create({
      data: {
        id:          '1',
        name:        'Crop Insurance – Kisumu Rainfall',
        category:    'crop',
        triggerType: 'Threshold',
        threshold:   '50.0000000',
        comparison:  'LessThan',
        coverageMin: '10.0000000',
        coverageMax: '1000.0000000',
        premiumRate: 500,
        maxDuration: 365,
        status:      'Active',
      },
    });
    console.log('Seed: Created initial product with ID "1"');
  } else {
    console.log('Seed: Initial product already exists');
  }

  // 2. Perform data migration: Identify policies with legacy 'rainfall:1' oracleKey and update them
  const legacyPolicies = await prisma.policy.findMany({
    where: { oracleKey: 'rainfall:1' },
  });

  if (legacyPolicies.length > 0) {
    console.log(`Found ${legacyPolicies.length} policies with legacy 'rainfall:1' oracleKey. Updating them...`);
    const updateResult = await prisma.policy.updateMany({
      where: { oracleKey: 'rainfall:1' },
      data: { oracleKey: 'rainfall:-0.0917,34.7679:2026-06' },
    });
    console.log(`Successfully migrated ${updateResult.count} policies.`);
  } else {
    console.log('No legacy policies with oracleKey "rainfall:1" found.');
  }

  console.log('Database seeding & migrations complete.');
}

main()
  .catch((e) => {
    console.error('Error during database seed/migration:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
