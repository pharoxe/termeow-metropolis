import { config } from "../config.js";
import { AutomationRepository } from "./repository.js";

/** One process-wide repository and connection pool shared by every automation route. */
export const automationRepository = new AutomationRepository(config.database.url, config.snapshot.dir);
