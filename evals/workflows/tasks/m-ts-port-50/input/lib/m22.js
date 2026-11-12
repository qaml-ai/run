'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_22 = 12;

function total22(qty) {
  return qty * RATE_22;
}

function describe22(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_22, total22(qty));
}

module.exports = describe22;
module.exports.total22 = total22;
