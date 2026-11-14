import { encodeVmPayer } from "../src/camelfs/usage.ts";

export const tenant = "usage-tenant";
export const event = {
  eventId: "vm:1", ulid: "01K00000000000000000000000", type: "usage.vm", vm: "vm",
  payer: encodeVmPayer({ tenant, agent: "workflow", kind: "workflow", rate: 0.002 }),
  pool: "test" as const, shape: { vcpus: 2, memoryMiB: 4096 }, host: "host",
  from: 1000, to: 3500, seconds: 999, final: true,
};
export const config = (url: string) => ({ HYPERDRIVE: { connectionString: url }, TEST_MODE: "1" });
export const page = (events: (Omit<typeof event, "vm"> & { vm?: string })[], cursor: string, watermark = Date.now()) =>
  ({ events, cursor, watermark });
