'use strict';
const { total28 } = require('./m28');
const { legacyFormat } = require('../util/legacy-format');

const RATE_35 = 6;

function total35(qty) {
  return qty * RATE_35;
}

function describe35(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_35, total35(qty));
}

function combined35(qty) {
  return legacyFormat('combined=%d (with m28: %d)', total35(qty) + total28(qty), total28(qty));
}

module.exports = { total35, describe35, combined35 };
