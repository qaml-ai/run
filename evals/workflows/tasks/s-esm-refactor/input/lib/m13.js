'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_13 = 4;

function total13(qty) {
  return qty * RATE_13;
}

function describe13(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_13, total13(qty));
}

exports.total13 = total13;
exports.describe13 = describe13;
