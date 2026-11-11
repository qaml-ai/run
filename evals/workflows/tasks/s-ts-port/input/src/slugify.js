const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A URL slug: accents dropped, lower case, `&` as "and", runs of anything else as one separator.
 * Options: `separator` (default "-"), `maxLength` (cut at a separator boundary when it can be).
 */
export function slugify(input, options = {}) {
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
