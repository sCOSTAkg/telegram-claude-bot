const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const ConfigManager = require('../src/core/config');

function withMockedFs(t, dataObject) {
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;

  let existsCalls = 0;
  let readCalls = 0;

  fs.existsSync = () => {
    existsCalls += 1;
    return true;
  };

  fs.readFileSync = () => {
    readCalls += 1;
    return JSON.stringify(dataObject);
  };

  t.after(() => {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
  });

  return {
    getExistsCalls: () => existsCalls,
    getReadCalls: () => readCalls,
  };
}

const cases = [
  { name: 'false', value: false },
  { name: '0', value: 0 },
  { name: "''", value: '' },
  { name: 'null', value: null },
];

for (const { name, value } of cases) {
  test(`get() returns and caches ${name} without extra file reads`, (t) => {
    const key = `k_${name}`;
    const counters = withMockedFs(t, { [key]: value });
    const manager = new ConfigManager('/tmp/config.json');

    const first = manager.get(key);
    assert.strictEqual(first, value);
    assert.equal(counters.getReadCalls(), 1);
    assert.equal(counters.getExistsCalls(), 1);
    assert.equal(manager.cache.has(key), true);
    assert.strictEqual(manager.cache.get(key), value);

    const second = manager.get(key);
    assert.strictEqual(second, value);
    assert.equal(counters.getReadCalls(), 1);
    assert.equal(counters.getExistsCalls(), 1);
  });
}
