'use strict';
const { total14 } = require('./m14');
const legacy = require('../util/legacy-format');
const fmt = legacy.legacyFormat;

const RATE_21 = 19;

function total21(qty) {
  return qty * RATE_21;
}

function describe21(name, qty) {
  return fmt('%s x%d @ %d = %d', name, qty, RATE_21, total21(qty));
}

function percent21(part, whole) {
  return fmt('%d%% of %s (%j)', part / whole * 100, 'tickets', { part: part, whole: whole });
}

function combined21(qty) {
  return fmt('combined=%d (with m14: %d)', total21(qty) + total14(qty), total14(qty));
}

module.exports = { total21, describe21, percent21, combined21 };
