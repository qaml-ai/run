/** The shared journey policy, with Node's database and transport services. */
import { Journey as CoreJourney, type JourneyOptions as CoreJourneyOptions } from "./core/journey.ts";
import { transaction, type Db } from "./db.ts";
import { readText } from "./http.ts";
import { safeError } from "./metrics.ts";
import { signedHeaders } from "./webhooks.ts";
export * from "./core/journey.ts";
export type JourneyOptions = Omit<CoreJourneyOptions, "host">;
export class Journey extends CoreJourney {
  constructor(options: JourneyOptions) {
    super({ ...options, host: {
      transaction: (db, work) => transaction(db as Db, work),
      readText, safeError, signedHeaders,
    } });
  }
}
