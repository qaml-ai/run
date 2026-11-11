'use strict';
const legacy = require('../util/legacy-format');
const fmt = legacy.legacyFormat;

const RATE_01 = 16;

function total01(qty) {
  return qty * RATE_01;
}

function describe01(name, qty) {
  return fmt('%s x%d @ %d = %d', name, qty, RATE_01, total01(qty));
}

module.exports = { total01, describe01 };
