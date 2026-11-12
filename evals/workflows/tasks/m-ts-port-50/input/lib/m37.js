'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_37 = 2;

function total37(qty) {
  return qty * RATE_37;
}

function describe37(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_37, total37(qty));
}

module.exports = describe37;
module.exports.total37 = total37;
