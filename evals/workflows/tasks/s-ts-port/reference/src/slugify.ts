const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface SlugifyOptions { separator?: string; maxLength?: number }

export function slugify(input: unknown, options: SlugifyOptions = {}): string {
  const separator = options.separator ?? "-";
  const maxLength = options.maxLength ?? Infinity;
  let slug = String(input)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, separator);
  if (!separator) return slug.slice(0, maxLength);
  const edges = new RegExp(`^(?:${escapeRegExp(separator)})+|(?:${escapeRegExp(separator)})+$`, "g");
  slug = slug.replace(edges, "");
  if (slug.length > maxLength) slug = slug.slice(0, maxLength).replace(edges, "");
  return slug;
}
