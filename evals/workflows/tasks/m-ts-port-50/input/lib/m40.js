'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_40 = 15;

function total40(qty) {
  return qty * RATE_40;
}

function describe40(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_40, total40(qty));
}

module.exports = { total40, describe40 };
