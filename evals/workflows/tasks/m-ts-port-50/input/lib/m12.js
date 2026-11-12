'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_12 = 17;

function total12(qty) {
  return qty * RATE_12;
}

function describe12(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_12, total12(qty));
}

function percent12(part, whole) {
  return legacyFormat('%d%% of %s (%j)', part / whole * 100, 'permits', { part: part, whole: whole });
}

module.exports = describe12;
module.exports.total12 = total12;
module.exports.percent12 = percent12;
