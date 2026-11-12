'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_32 = 10;

function total32(qty) {
  return qty * RATE_32;
}

function describe32(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_32, total32(qty));
}

module.exports = describe32;
module.exports.total32 = total32;
