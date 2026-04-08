import { startBot } from './src/bot/telegram.js';
import { startScheduler } from './src/bot/scheduler.js';

console.log("Starting the Job Agent Bot...");

async function main() {
  await startBot();
  startScheduler();
}

main().catch((error) => {
  console.error("Failed to start the bot:", error);
  process.exit(1);
});
