'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_15 = 9;

function total15(qty) {
  return qty * RATE_15;
}

function describe15(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_15, total15(qty));
}

function percent15(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'vouchers', { part: part, whole: whole });
}

module.exports = { total15, describe15, percent15 };
