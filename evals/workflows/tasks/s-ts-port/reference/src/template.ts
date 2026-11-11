import { escapeHtml } from "./escape.ts";

export function lookup(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]), data);
}

export interface RenderOptions { escape?: boolean; missing?: string; strict?: boolean }

export function render(template: string, data: unknown, options: RenderOptions = {}): string {
  const escape = options.escape ?? true;
  return template.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g, (_match, rawPath: string | undefined, path: string | undefined) => {
    const key = (rawPath ?? path)!;
    const value = lookup(data, key);
    if (value === undefined || value === null) {
      if (options.strict) throw new Error(`Missing value for ${key}`);
      return options.missing ?? "";
    }
    return rawPath || !escape ? String(value) : escapeHtml(value);
  });
}
