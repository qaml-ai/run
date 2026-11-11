'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_44 = 11;

function total44(qty) {
  return qty * RATE_44;
}

function describe44(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_44, total44(qty));
}

module.exports = { total44, describe44 };
