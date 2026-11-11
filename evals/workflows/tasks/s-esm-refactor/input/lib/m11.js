'use strict';
const legacy = require('../util/legacy-format');
const fmt = legacy.legacyFormat;

const RATE_11 = 19;

function total11(qty) {
  return qty * RATE_11;
}

function describe11(name, qty) {
  return fmt('%s x%d @ %d = %d', name, qty, RATE_11, total11(qty));
}

module.exports = { total11, describe11 };
