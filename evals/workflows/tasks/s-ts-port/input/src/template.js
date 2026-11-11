import { escapeHtml } from "./escape.js";

/** A dotted path into an object ("user.address.city"); undefined when any step is missing. */
export function lookup(data, path) {
  return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), data);
}

/**
 * Fills `{{ path }}` (HTML-escaped) and `{{{ path }}}` (raw). A missing value renders as `missing` (default ""),
 * or throws with `strict`. `escape: false` leaves double-brace values raw too.
 */
export function render(template, data, options = {}) {
  const escape = options.escape ?? true;
  return template.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g, (_match, rawPath, path) => {
    const key = rawPath ?? path;
    const value = lookup(data, key);
    if (value === undefined || value === null) {
      if (options.strict) throw new Error(`Missing value for ${key}`);
      return options.missing ?? "";
    }
    return rawPath || !escape ? String(value) : escapeHtml(value);
  });
}
