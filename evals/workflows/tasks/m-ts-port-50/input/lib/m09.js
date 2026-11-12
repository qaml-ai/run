'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_09 = 8;

function total09(qty) {
  return qty * RATE_09;
}

function describe09(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_09, total09(qty));
}

function percent09(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'bundles', { part: part, whole: whole });
}

module.exports = { total09, describe09, percent09 };
