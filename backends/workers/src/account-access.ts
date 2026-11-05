// Generated from src/api.ts; OAuth's public API allowlist is unchanged.
const OAUTH_ROUTES = [
  /^(?:GET|POST) \/v1\/workspaces$/,
  /^(?:GET|PATCH) \/v1\/workspaces\/[^/]+(?:\/members)?$/,
  /^GET \/v1\/workspace-memberships$/,
  /^PUT \/v1\/workspace-memberships\/(?:agent|definition)\/[^/]+$/,
  /^GET \/v1\/(?:me|models|providers|inputs|usage|billing|billing\/ledger)$/,
  /^(?:GET|POST) \/v1\/agents$/,
  /^(?:GET|DELETE) \/v1\/agents\/[^/]+$/,
  /^(?:GET|POST|PUT|PATCH|DELETE) \/v1\/agents\/[^/]+\/(?:abort|configuration|context\/reset|events|fork|history|inputs|inputs\/[^/]+|mounts|prompt|requests\/[^/]+|schedules|schedules\/[^/]+|schedule-deliveries|state|uploads\/[^/]+\/[^/]+)$/,
  /^(?:GET|POST|PATCH|DELETE) \/v1\/definitions(?:\/[^/]+(?:\/agents)?)?$/,
  /^POST \/v1\/(?:transcriptions|images|speech)$/,
  /^(?:POST \/v1\/runs|(?:GET|DELETE) \/v1\/runs\/[^/]+|GET \/v1\/runs\/[^/]+\/(?:events|messages)|POST \/v1\/runs\/[^/]+\/abort)$/,
];
export const oauthAllows = (method: string, path: string) => OAUTH_ROUTES.some(allowed => allowed.test(`${method} ${path}`));
