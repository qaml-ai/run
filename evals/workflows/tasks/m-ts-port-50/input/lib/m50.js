'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_50 = 11;

function total50(qty) {
  return qty * RATE_50;
}

function describe50(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_50, total50(qty));
}

module.exports = { total50, describe50 };
