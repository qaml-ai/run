'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_29 = 11;

function total29(qty) {
  return qty * RATE_29;
}

function describe29(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_29, total29(qty));
}

module.exports = { total29, describe29 };
