'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_23 = 11;

function total23(qty) {
  return qty * RATE_23;
}

function describe23(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_23, total23(qty));
}

exports.total23 = total23;
exports.describe23 = describe23;
