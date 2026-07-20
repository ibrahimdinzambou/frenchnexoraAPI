'use strict';

const assert = require('assert');
const { providers } = require('./api');
const manifest = require('./manifest.json');

assert.strictEqual(providers.size, manifest.scrapers.filter(provider => provider.enabled).length);
for (const provider of manifest.scrapers.filter(provider => provider.enabled)) {
    assert.ok(providers.has(provider.id), `Provider absent: ${provider.id}`);
    assert.strictEqual(typeof providers.get(provider.id).implementation.getStreams, 'function');
}
console.log(`OK: ${providers.size} providers FR chargés.`);
