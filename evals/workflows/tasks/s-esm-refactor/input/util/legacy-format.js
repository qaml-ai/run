'use strict';
// The printf-style formatter every module still uses. %s is String(value), %d truncates toward zero after
// Number(value) (so "7.9" is 7, -1.5 is -1, and NaN prints "NaN"), %j is JSON.stringify, %% is a literal %.
// Extra arguments are ignored; a missing one prints "undefined" (%s), "NaN" (%d) or "undefined" (%j).
function legacyFormat(template, ...args) {
  let next = 0;
  return template.replace(/%([sdj%])/g, (_match, type) => {
    if (type === '%') return '%';
    const value = args[next++];
    if (type === 's') return String(value);
    if (type === 'd') return String(Math.trunc(Number(value)));
    return JSON.stringify(value);
  });
}
module.exports = { legacyFormat };
