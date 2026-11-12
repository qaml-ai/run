'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_45 = 15;

function total45(qty) {
  return qty * RATE_45;
}

function describe45(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_45, total45(qty));
}

function percent45(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'coupons', { part: part, whole: whole });
}

module.exports = { total45, describe45, percent45 };
