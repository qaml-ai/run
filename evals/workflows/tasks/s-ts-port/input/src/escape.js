const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const REVERSE = Object.fromEntries(Object.entries(ENTITIES).map(([character, entity]) => [entity, character]));

export const escapeHtml = (input) => String(input).replace(/[&<>"']/g, (character) => ENTITIES[character]);
export const unescapeHtml = (input) => String(input).replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => REVERSE[entity]);
