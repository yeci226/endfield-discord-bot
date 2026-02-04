import { ExtendedClient } from "../src/structures/Client";
import { AutoDailyService } from "../src/services/AutoDailyService";
import moment from "moment-timezone";
import colors from "colors";

async function runCatchup() {
  console.log(colors.cyan("🚀 Starting AutoDaily Catch-up Script..."));

  const client = new ExtendedClient();
  client.autoDailyService = new AutoDailyService(client);

  const currentHour = parseInt(moment().tz("Asia/Taipei").format("H"));
  console.log(colors.yellow(`Current Taipei Hour: ${currentHour}:00`));

  try {
    console.log(
      colors.blue(`[Catch-up] Processing hours 0 to ${currentHour}...`),
    );
    await client.autoDailyService.manualRunRange(0, currentHour);
    console.log(colors.green("✅ Catch-up completed successfully."));
  } catch (error: any) {
    console.error(colors.red("❌ Catch-up failed:"), error.message || error);
  } finally {
    process.exit(0);
  }
}

runCatchup();
