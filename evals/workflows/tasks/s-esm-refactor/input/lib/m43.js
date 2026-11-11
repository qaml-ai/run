'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_43 = 11;

function total43(qty) {
  return qty * RATE_43;
}

function describe43(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_43, total43(qty));
}

exports.total43 = total43;
exports.describe43 = describe43;
