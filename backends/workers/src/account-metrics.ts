/** Never put a response, secret or request URL in an auth error log. */
export const safeError = (error: unknown) => error instanceof Error ? error.name : "Error";
