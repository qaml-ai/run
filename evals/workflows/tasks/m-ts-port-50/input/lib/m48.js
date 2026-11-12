'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_48 = 4;

function total48(qty) {
  return qty * RATE_48;
}

function describe48(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_48, total48(qty));
}

function percent48(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'parcels', { part: part, whole: whole });
}

exports.total48 = total48;
exports.describe48 = describe48;
exports.percent48 = percent48;
