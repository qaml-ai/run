'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_25 = 7;

function total25(qty) {
  return qty * RATE_25;
}

function describe25(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_25, total25(qty));
}

module.exports = { total25, describe25 };
