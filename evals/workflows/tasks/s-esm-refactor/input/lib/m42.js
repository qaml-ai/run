'use strict';
const { total35 } = require('./m35');
const { legacyFormat } = require('../util/legacy-format');

const RATE_42 = 16;

function total42(qty) {
  return qty * RATE_42;
}

function describe42(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_42, total42(qty));
}

function percent42(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'pallets', { part: part, whole: whole });
}

function combined42(qty) {
  return legacyFormat('combined=%d (with m35: %d)', total42(qty) + total35(qty), total35(qty));
}

module.exports = describe42;
module.exports.total42 = total42;
module.exports.percent42 = percent42;
module.exports.combined42 = combined42;
