export { LegacyV1 } from "./index.ts";
export { LegacyGatewayTextRoutes } from "./legacy-gateway-text-routes.ts";

export default { fetch: () => new Response(null, { status: 404 }) };
