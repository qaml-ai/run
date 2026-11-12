'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_05 = 18;

function total05(qty) {
  return qty * RATE_05;
}

function describe05(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_05, total05(qty));
}

module.exports = { total05, describe05 };
