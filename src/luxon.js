'use strict';
// Luxon shim. Inside an n8n Code node, Luxon's DateTime is a global. In unit
// tests (plain Node) it comes from the luxon package. The build never bundles
// 'luxon' itself; only relative requires are inlined.
/* global DateTime, Interval, Duration */
if (typeof DateTime !== 'undefined') {
  module.exports = { DateTime, Interval: typeof Interval !== 'undefined' ? Interval : undefined,
                     Duration: typeof Duration !== 'undefined' ? Duration : undefined };
} else {
  module.exports = require('luxon');
}
