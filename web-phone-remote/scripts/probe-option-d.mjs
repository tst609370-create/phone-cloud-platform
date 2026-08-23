#!/usr/bin/env node
// Smoke-test probe for Option D: shows what nodejs.checkLatest would decide
// given the current manifest + nodejs.org LTS list. Read-only, no side effects.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const NODE_LTS_ABI = { 20: '115', 22: '127', 24: '137' };

const manifestPath = path.resolve('dependencies', 'node-pty', 'manifest.json');
let manifest = null;
if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

console.log('---------- current manifest ----------');
console.log(manifest ? JSON.stringify(manifest, null, 2) : '(none — would fall back to unfiltered latest)');
console.log();

console.log('---------- NODE_LTS_ABI map ----------');
console.log(NODE_LTS_ABI);
console.log();

console.log('---------- fetching nodejs.org/dist/index.json ----------');
const res = await fetch('https://nodejs.org/dist/index.json');
const releases = await res.json();
const ltsReleases = releases.filter((r) => r.lts !== false);
console.log(`${ltsReleases.length} LTS releases in feed`);
console.log('Newest 6 LTS:');
for (const r of ltsReleases.slice(0, 6)) {
    const major = Number(r.version.replace(/^v/, '').split('.')[0]);
    const abi = NODE_LTS_ABI[major];
    const covered = manifest && abi !== undefined && manifest.coveredAbis.includes(abi);
    const flag = covered ? '✓' : abi === undefined ? '? (unknown major)' : '✗ (no prebuilt)';
    console.log(`  ${r.version.padEnd(12)} lts=${r.lts.padEnd(10)} abi=${abi ?? '??'}  ${flag}`);
}
console.log();

console.log('---------- Option D decision ----------');
if (!manifest) {
    console.log(`FALLBACK (manifest missing): would return ${ltsReleases[0].version.replace(/^v/, '')}`);
    console.log('WARN: Prebuilt manifest unavailable; Node update gating skipped');
} else {
    const covered = new Set(manifest.coveredAbis);
    const candidates = ltsReleases.filter((r) => {
        const major = Number(r.version.replace(/^v/, '').split('.')[0]);
        const abi = NODE_LTS_ABI[major];
        return abi !== undefined && covered.has(abi);
    });
    if (candidates.length === 0) {
        console.log('NO CANDIDATES: would return null (status stays Unknown)');
    } else {
        const filtered = candidates[0];
        const unfiltered = ltsReleases[0];
        console.log(`FILTERED LATEST: ${filtered.version.replace(/^v/, '')}`);
        if (filtered.version !== unfiltered.version) {
            console.log(`WARN would fire: Node ${unfiltered.version.replace(/^v/, '')} available but no matching node-pty prebuilt; staying on filter max ${filtered.version.replace(/^v/, '')}`);
        } else {
            console.log('(No WARN: filter max matches unfiltered latest — Option D is a no-op for current state)');
        }
    }
}
