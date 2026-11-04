// Resolve the unchanged repository SDK's runtime dependency from this package.
// This avoids installing or changing anything in the parent ECS runtime.
import { register } from 'node:module';
register('./sdk-resolve.mjs', import.meta.url);
