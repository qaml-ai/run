'use strict';
const { total21 } = require('./m21');
const { legacyFormat } = require('../util/legacy-format');

const RATE_28 = 13;

function total28(qty) {
  return qty * RATE_28;
}

function describe28(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_28, total28(qty));
}

function combined28(qty) {
  return legacyFormat('combined=%d (with m21: %d)', total28(qty) + total21(qty), total21(qty));
}

exports.total28 = total28;
exports.describe28 = describe28;
exports.combined28 = combined28;
