'use strict';
const legacy = require('../util/legacy-format');
const fmt = legacy.legacyFormat;

const RATE_31 = 10;

function total31(qty) {
  return qty * RATE_31;
}

function describe31(name, qty) {
  return fmt('%s x%d @ %d = %d', name, qty, RATE_31, total31(qty));
}

module.exports = { total31, describe31 };
