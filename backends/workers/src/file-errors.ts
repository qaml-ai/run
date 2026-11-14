import { normalizePath as sourceNormalizePath } from "./file-policy.ts";
import { HttpError } from "./errors.ts";

export class FileError extends HttpError {
  constructor(message: string, status = 400) {
    super(status, `FILE_${status}:${message}`);
  }
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizePath(value: unknown): string {
  try {
    return sourceNormalizePath(value);
  } catch (error) {
    if (error instanceof HttpError) throw new FileError(error.message, error.status);
    throw error;
  }
}
