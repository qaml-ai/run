'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_04 = 18;

function total04(qty) {
  return qty * RATE_04;
}

function describe04(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_04, total04(qty));
}

module.exports = { total04, describe04 };
