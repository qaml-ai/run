'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_33 = 4;

function total33(qty) {
  return qty * RATE_33;
}

function describe33(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_33, total33(qty));
}

function percent33(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'vouchers', { part: part, whole: whole });
}

exports.total33 = total33;
exports.describe33 = describe33;
exports.percent33 = percent33;
