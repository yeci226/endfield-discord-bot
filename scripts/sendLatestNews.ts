import { ExtendedClient } from "../src/structures/Client";
import { SkportNewsService } from "../src/services/SkportNewsService";
import { Logger } from "../src/utils/Logger";

const logger = new Logger("ManualNewsDispatch");

async function run() {
  const client = new ExtendedClient();
  client.newsService = new SkportNewsService(client);

  logger.info("Initializing client for manual news dispatch...");

  client.once("ready", async () => {
    logger.info(`Logged in as ${client.user?.tag}`);
    logger.info("Triggering manual news check...");

    try {
      await client.newsService.manualCheckNews(true);
      logger.success("Force news dispatch completed.");
    } catch (error) {
      logger.error(`Error during force news dispatch: ${error}`);
    } finally {
      logger.info("Closing client...");
      client.destroy();
      process.exit(0);
    }
  });

  client.start();
}

run().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
