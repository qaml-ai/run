import { writeFileSync } from "node:fs";
import { openapiDocument } from "../src/api.ts";

writeFileSync(new URL("../openapi.json", import.meta.url), `${JSON.stringify(openapiDocument(), null, 2)}\n`);
