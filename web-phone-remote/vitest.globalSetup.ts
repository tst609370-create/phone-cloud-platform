import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export async function setup() {
    // Pre-populate node-pty binary so the integration test has a fixture to tar up
    // and so happy-path unit tests can require('node-pty') successfully.
    const activeDir = path.resolve('node_modules', 'node-pty', 'build', 'Release');
    if (fs.existsSync(path.join(activeDir, 'pty.node'))) {
        console.log('[vitest.globalSetup] node-pty binary already present, skipping fetch');
        return;
    }
    console.log('[vitest.globalSetup] fetching node-pty prebuilt...');
    execFileSync('node', ['scripts/fetch-prebuilts.mjs'], { stdio: 'inherit' });
}
