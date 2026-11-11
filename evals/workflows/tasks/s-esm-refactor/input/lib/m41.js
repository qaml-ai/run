'use strict';
const legacy = require('../util/legacy-format');
const fmt = legacy.legacyFormat;

const RATE_41 = 6;

function total41(qty) {
  return qty * RATE_41;
}

function describe41(name, qty) {
  return fmt('%s x%d @ %d = %d', name, qty, RATE_41, total41(qty));
}

module.exports = { total41, describe41 };
