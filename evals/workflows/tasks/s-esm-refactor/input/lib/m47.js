'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_47 = 5;

function total47(qty) {
  return qty * RATE_47;
}

function describe47(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_47, total47(qty));
}

module.exports = describe47;
module.exports.total47 = total47;
