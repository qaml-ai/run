'use strict';
const legacy = require('../util/legacy-format');
const fmt = legacy.legacyFormat;

const RATE_16 = 17;

function total16(qty) {
  return qty * RATE_16;
}

function describe16(name, qty) {
  return fmt('%s x%d @ %d = %d', name, qty, RATE_16, total16(qty));
}

module.exports = { total16, describe16 };
