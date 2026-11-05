import assert from 'node:assert/strict';
import test from 'node:test';
import { assignPort } from './assignPort.mjs';

test('first device gets 10000, not a shared 10002', () => {
    assert.equal(assignPort([], 'device-a'), 10000);
});

test('two devices never share a port and a returning device keeps its port', () => {
    const first = assignPort([], 'device-a');
    const records = [{ deviceId: 'device-a', port: first }];
    const second = assignPort(records, 'device-b');
    assert.notEqual(first, second);
    assert.equal(assignPort(records, 'device-a'), first);
    assert.equal(second, 10001);
});

test('returns null when the published range is full', () => {
    const records = [];
    for (let port = 10000; port <= 10100; port++) records.push({ deviceId: `d${port}`, port });
    assert.equal(assignPort(records, 'new'), null);
});
