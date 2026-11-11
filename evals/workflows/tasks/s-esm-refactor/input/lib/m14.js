'use strict';
const { total07 } = require('./m07');
const { legacyFormat } = require('../util/legacy-format');

const RATE_14 = 5;

function total14(qty) {
  return qty * RATE_14;
}

function describe14(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_14, total14(qty));
}

function combined14(qty) {
  return legacyFormat('combined=%d (with m07: %d)', total14(qty) + total07(qty), total07(qty));
}

module.exports = { total14, describe14, combined14 };
