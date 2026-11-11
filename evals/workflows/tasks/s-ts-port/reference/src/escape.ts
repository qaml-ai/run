const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const REVERSE: Record<string, string> = Object.fromEntries(Object.entries(ENTITIES).map(([character, entity]) => [entity, character]));

export const escapeHtml = (input: unknown): string => String(input).replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
export const unescapeHtml = (input: unknown): string => String(input).replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => REVERSE[entity] ?? entity);
