/**
 * Standalone DB connection test — simulates the exact query the VM fails on.
 * Run with: npx tsx test-db.ts
 * Switch DATABASE_URL to the production URL to simulate the VM environment.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaNeonHttp } from '@prisma/adapter-neon';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('❌ DATABASE_URL is not set in your .env file');
  process.exit(1);
}

console.log(`🔌 Connecting to: ${url.replace(/:([^:@]+)@/, ':****@')}`);

const adapter = new PrismaNeonHttp(url, { arrayMode: false, fullResults: false });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('⏳ Running prisma.users.findUnique (the query that fails on VM)...');
  
  try {
    const result = await prisma.users.findUnique({
      where: { telegram_chat_id: BigInt(999999999) } // fake ID — will return null, not error
    });
    console.log('✅ Query succeeded! Result:', result); // should print null (user doesn't exist)
  } catch (e: any) {
    console.error('❌ Query failed!');
    console.error('   Code:', e.code);
    console.error('   Message:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
