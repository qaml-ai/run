'use strict';
const legacy = require('../util/legacy-format');
const fmt = legacy.legacyFormat;

const RATE_26 = 7;

function total26(qty) {
  return qty * RATE_26;
}

function describe26(name, qty) {
  return fmt('%s x%d @ %d = %d', name, qty, RATE_26, total26(qty));
}

module.exports = { total26, describe26 };
