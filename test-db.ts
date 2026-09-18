
import 'dotenv/config';

// Import prisma from db.ts — this runs the same undici IPv4 fix + PrismaNeonHttp setup
import { prisma } from './src/data/db.js';

const url = process.env.DATABASE_URL;
console.log(`🔌 Connecting to: ${url?.replace(/:([^:@]+)@/, ':****@') ?? '(not set)'}`);

async function main() {
  console.log('⏳ Running prisma.users.findUnique (the query that fails on VM)...');
  
  try {
    const result = await prisma.users.findUnique({
      where: { telegram_chat_id: BigInt(999999999) } // fake ID — returns null, not error
    });
    console.log('✅ Query succeeded! Result:', result);
  } catch (e: any) {
    console.error('❌ Query failed!');
    console.error('   Message:', e.message);
    console.error('   Cause:', e.sourceError?.cause?.message ?? e.cause?.message ?? 'none');
  } finally {
    await prisma.$disconnect();
  }
}

main();

