# strkit

Small, dependency-free string utilities. Every module in `src/` is plain ES module JavaScript;
`src/index.js` re-exports them all. Tests use `node:test` (`npm test`).

| Module | Exports |
| --- | --- |
| words | `splitWords` |
| case | `camelCase`, `pascalCase`, `snakeCase`, `kebabCase`, `constantCase` |
| slugify | `slugify` |
| truncate | `truncate` |
| wrap | `wordWrap` |
| levenshtein | `distance`, `closest` |
| pluralize | `plural`, `pluralize` |
| escape | `escapeHtml`, `unescapeHtml` |
| template | `render`, `lookup` |
| csv | `parseCsv`, `toCsv` |
| pad | `padStart`, `padEnd`, `center` |
| table | `formatTable` |
| bytes | `formatBytes`, `parseBytes` |
| duration | `formatDuration`, `parseDuration` |
| ordinal | `ordinal` |
