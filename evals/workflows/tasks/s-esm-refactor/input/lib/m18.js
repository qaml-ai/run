'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_18 = 11;

function total18(qty) {
  return qty * RATE_18;
}

function describe18(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_18, total18(qty));
}

function percent18(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'coupons', { part: part, whole: whole });
}

exports.total18 = total18;
exports.describe18 = describe18;
exports.percent18 = percent18;
