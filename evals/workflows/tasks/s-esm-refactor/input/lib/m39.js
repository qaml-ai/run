'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_39 = 17;

function total39(qty) {
  return qty * RATE_39;
}

function describe39(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_39, total39(qty));
}

function percent39(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'vouchers', { part: part, whole: whole });
}

module.exports = { total39, describe39, percent39 };
