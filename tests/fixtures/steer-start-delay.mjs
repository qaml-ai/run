// Loaded only by the HTTP test fixture, in the server process in both hosting modes.
import { setTimeout as sleep } from "node:timers/promises";
import { ClientSessions } from "../../src/client-sessions.ts";
import { AgentSupervisor } from "../../src/supervisor.ts";

const delayMs = Number(process.env.TEST_STEER_START_DELAY_MS);
const steerEntered = Promise.withResolvers();
process.once("SIGTERM", steerEntered.resolve);

const start = AgentSupervisor.prototype.start;
AgentSupervisor.prototype.start = async function (...args) {
  // Start the delay only after the steer arrives at the wait loop, even on a loaded shard.
  await steerEntered.promise;
  if (delayMs > 0) await sleep(delayMs);
  return start.apply(this, args);
};

const steerTurn = ClientSessions.prototype.steerTurn;
ClientSessions.prototype.steerTurn = function (...args) {
  steerEntered.resolve();
  return steerTurn.apply(this, args);
};
