'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_34 = 8;

function total34(qty) {
  return qty * RATE_34;
}

function describe34(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_34, total34(qty));
}

module.exports = { total34, describe34 };
