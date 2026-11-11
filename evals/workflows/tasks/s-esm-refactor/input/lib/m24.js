'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_24 = 5;

function total24(qty) {
  return qty * RATE_24;
}

function describe24(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_24, total24(qty));
}

function percent24(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'invoices', { part: part, whole: whole });
}

module.exports = { total24, describe24, percent24 };
