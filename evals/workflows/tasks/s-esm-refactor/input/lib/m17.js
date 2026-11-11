'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_17 = 16;

function total17(qty) {
  return qty * RATE_17;
}

function describe17(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_17, total17(qty));
}

module.exports = describe17;
module.exports.total17 = total17;
