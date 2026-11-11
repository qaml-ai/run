'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_30 = 8;

function total30(qty) {
  return qty * RATE_30;
}

function describe30(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_30, total30(qty));
}

function percent30(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'coupons', { part: part, whole: whole });
}

module.exports = { total30, describe30, percent30 };
