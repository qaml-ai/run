'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_08 = 3;

function total08(qty) {
  return qty * RATE_08;
}

function describe08(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_08, total08(qty));
}

exports.total08 = total08;
exports.describe08 = describe08;
