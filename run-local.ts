import { runAutoApplyCycle } from './src/modules/autoApply.js';

console.log("🚀 Starting a manual local run of the Job Agent...");
console.log("This will run one cycle without starting the Telegram polling listener, avoiding conflicts with your VM.");

runAutoApplyCycle()
  .then(() => {
    console.log("✅ Local run finished.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Fatal error during local run:", err);
    process.exit(1);
  });
