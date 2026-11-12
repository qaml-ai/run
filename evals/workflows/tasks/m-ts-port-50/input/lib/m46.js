'use strict';
const legacy = require('../util/legacy-format');
const fmt = legacy.legacyFormat;

const RATE_46 = 16;

function total46(qty) {
  return qty * RATE_46;
}

function describe46(name, qty) {
  return fmt('%s x%d @ %d = %d', name, qty, RATE_46, total46(qty));
}

module.exports = { total46, describe46 };
