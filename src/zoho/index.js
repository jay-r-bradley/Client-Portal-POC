const { LiveCrm } = require('./liveCrm');
const { MockCrm } = require('./mockCrm');

function createCrm(config) {
  if (config.zohoMode === 'live') return new LiveCrm(config);
  if (config.zohoMode === 'mock') return new MockCrm(config);
  throw new Error(`Unknown ZOHO_MODE "${config.zohoMode}". Use "mock" or "live".`);
}

module.exports = { createCrm };
