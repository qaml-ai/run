'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_10 = 12;

function total10(qty) {
  return qty * RATE_10;
}

function describe10(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_10, total10(qty));
}

module.exports = { total10, describe10 };
