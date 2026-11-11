# Migrating ledger-labels to ES modules

The package is CommonJS on a printf-style formatter (`util/legacy-format.js`). Move it to native ES modules and
drop the formatter.

1. `package.json` gets `"type": "module"`. Every file under `lib/` becomes an ES module: `import`/`export`, no
   `require`, no `module.exports`/`exports.`, no `'use strict'`. Relative imports name the file with its `.js`
   extension.
2. Every export keeps its name. A module that exported a single function (`module.exports = fn`) exports it as
   `export default` and keeps its extra properties as named exports. `lib/index.js` re-exports each module as a
   namespace under the same key (`export * as m01 from "./m01.js"`).
3. Replace every `legacyFormat` call with a template literal that prints exactly the same text, then delete
   `util/legacy-format.js`. Mind the formatter's rules (its header comment): `%d` truncates toward zero after
   `Number()`, `%j` is `JSON.stringify`, `%%` is `%`.
4. Behaviour must not change: every exported function returns exactly what it returned before, for any input.
