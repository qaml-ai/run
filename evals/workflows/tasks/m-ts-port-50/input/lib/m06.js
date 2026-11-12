'use strict';
const legacy = require('../util/legacy-format');
const fmt = legacy.legacyFormat;

const RATE_06 = 19;

function total06(qty) {
  return qty * RATE_06;
}

function describe06(name, qty) {
  return fmt('%s x%d @ %d = %d', name, qty, RATE_06, total06(qty));
}

function percent06(part, whole) {
  return fmt('%d%% of %s (%j)', part / whole * 100, 'tickets', { part: part, whole: whole });
}

module.exports = { total06, describe06, percent06 };
