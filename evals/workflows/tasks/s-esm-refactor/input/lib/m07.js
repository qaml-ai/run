'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_07 = 13;

function total07(qty) {
  return qty * RATE_07;
}

function describe07(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_07, total07(qty));
}

module.exports = describe07;
module.exports.total07 = total07;
