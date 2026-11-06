import { errorCode } from "./http-error-policy.ts";
export { errorCode, errorFields, errorHeaders, errorStatus } from "./http-error-policy.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(
    status: number,
    message: string,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = errorCode({ code, message }, status);
    this.details = details;
  }
}
