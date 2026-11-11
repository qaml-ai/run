'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_02 = 12;

function total02(qty) {
  return qty * RATE_02;
}

function describe02(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_02, total02(qty));
}

module.exports = describe02;
module.exports.total02 = total02;
