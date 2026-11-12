'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_27 = 19;

function total27(qty) {
  return qty * RATE_27;
}

function describe27(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_27, total27(qty));
}

function percent27(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'pallets', { part: part, whole: whole });
}

module.exports = describe27;
module.exports.total27 = total27;
module.exports.percent27 = percent27;
