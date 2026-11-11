'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_19 = 2;

function total19(qty) {
  return qty * RATE_19;
}

function describe19(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_19, total19(qty));
}

module.exports = { total19, describe19 };
