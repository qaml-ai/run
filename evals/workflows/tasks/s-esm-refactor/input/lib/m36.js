'use strict';
const legacy = require('../util/legacy-format');
const fmt = legacy.legacyFormat;

const RATE_36 = 5;

function total36(qty) {
  return qty * RATE_36;
}

function describe36(name, qty) {
  return fmt('%s x%d @ %d = %d', name, qty, RATE_36, total36(qty));
}

function percent36(part, whole) {
  return fmt('%d%% of %s (%j)', part / whole * 100, 'widgets', { part: part, whole: whole });
}

module.exports = { total36, describe36, percent36 };
