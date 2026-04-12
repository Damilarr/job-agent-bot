import { bot, BOT_MENU_COMMANDS, setBotDescription } from "./botInstance.js";

import "./handlers/callbacks.js";
import "./handlers/commands.js";
import "./handlers/messages.js";

export async function startBot() {
  try {
    await bot.api.setMyCommands(BOT_MENU_COMMANDS);
    console.log("📋 Bot menu commands updated.");
  } catch (e) {
    console.error("Failed to set bot menu commands:", e);
  }
  await setBotDescription();
  bot.start();
  console.log("🤖 Job Agent Bot is running...");
  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());
}

export { bot, refreshBotMenu, setBotDescription } from "./botInstance.js";
