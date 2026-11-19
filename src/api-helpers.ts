import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError } from "./http.ts";

export const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });
export const content = (value: z.ZodType) => ({ content: { "application/json": { schema: value } } });
export const reply = (description: string, value: z.ZodType) => ({ description, ...content(value) });
export const binary = (description: string) => ({ description, content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } });

export const invalid = (message: string): never => { throw new HttpError(400, message); };

export function parse<T extends z.ZodType>(type: T, value: unknown): z.infer<T> {
  const result = type.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0].message);
  return result.data;
}
