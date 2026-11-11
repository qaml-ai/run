'use strict';
const { legacyFormat } = require('../util/legacy-format');

const RATE_38 = 18;

function total38(qty) {
  return qty * RATE_38;
}

function describe38(name, qty) {
  return legacyFormat('%s x%d @ %d = %d', name, qty, RATE_38, total38(qty));
}

exports.total38 = total38;
exports.describe38 = describe38;
