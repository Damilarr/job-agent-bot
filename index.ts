import { startBot } from './src/modules/telegram.js';
import { startScheduler } from './src/modules/scheduler.js';

console.log("Starting the Job Agent Bot...");

try {
  startBot();
  startScheduler();
} catch (error) {
  console.error("Failed to start the bot:", error);
  process.exit(1);
}
