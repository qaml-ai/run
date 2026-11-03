// An error with the HTTP status it answers with: its own module, so code that only throws one (an agent's host, which
// has no server and no database) loads neither http.ts nor what it brings.
export class HttpError extends Error {
  status: number;
  /** A machine-readable code for the error body (see `errorCode`); by default one for its status. */
  code?: string;
  /** Fields the error body carries beside `error` and `code`, for a caller to act on (a limit and what raises it). */
  details?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) { super(message); this.status = status; if (code) this.code = code; if (details) this.details = details; }
}
