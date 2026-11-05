import { Outbound } from "../src/security-outbound.ts";

export type Delivery = { url: string; headers: Record<string, string>; body: string; json: any };

/** Delivery-only fake: real Workers URL policy, no DNS lookup or external request. */
export class TestOutbound {
  readonly deliveries: Delivery[] = [];
  private readonly policy = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] });
  respond: (delivery: Delivery) => Response | Promise<Response> = () => new Response(null, { status: 204 });

  check(value: string) { return this.policy.check(value); }

  async fetch(url: string, init: RequestInit) {
    this.check(url);
    const body = String(init.body);
    const delivery = { url, headers: Object.fromEntries(new Headers(init.headers)), body, json: JSON.parse(body) };
    this.deliveries.push(delivery);
    return this.respond(delivery);
  }
}
