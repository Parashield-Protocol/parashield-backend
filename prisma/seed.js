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

  console.log('Database seeding complete.');
}

main()
  .catch((e) => {
    console.error('Error during database seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
