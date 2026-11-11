'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_03 = 10;

function total03(qty) {
  return qty * RATE_03;
}

function describe03(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_03, total03(qty));
}

function percent03(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'coupons', { part: part, whole: whole });
}

exports.total03 = total03;
exports.describe03 = describe03;
exports.percent03 = percent03;
