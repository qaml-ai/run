'use strict';
const { total42 } = require('./m42');
const { legacyFormat } = require('../util/legacy-format');

const RATE_49 = 18;

function total49(qty) {
  return qty * RATE_49;
}

function describe49(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_49, total49(qty));
}

function combined49(qty) {
  return legacyFormat('combined=%d (with m42: %d)', total49(qty) + total42(qty), total42(qty));
}

module.exports = { total49, describe49, combined49 };
