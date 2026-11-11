'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_20 = 16;

function total20(qty) {
  return qty * RATE_20;
}

function describe20(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_20, total20(qty));
}

module.exports = { total20, describe20 };
