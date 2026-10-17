#!/usr/bin/env node
/*
 * Deploy workflow tests. No framework:  node test/workflow.test.mjs
 * The test job runs repo code with the job's GITHUB_TOKEN. Only the deploy job
 * may push images, so only it may hold packages: write. CI must run the full
 * check (scripts/check.sh: syntax, every test, dataset, DOM contract, server
 * smoke test), not only `npm test`.
 */
import fs from 'node:fs';

let fails = 0;
const check = (ok, label) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); };

const yml = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8').replace(/^\s*#.*$/gm, '');
const [top, jobs = ''] = yml.split(/^jobs:\s*$/m);
const [testJob, deployJob = ''] = jobs.split(/^  deploy:\s*$/m);

console.log('\n# permissions\n');
check(!/packages:\s*write/.test(top), 'no packages: write at the workflow level');
check(!/packages:\s*write/.test(testJob), 'the test job cannot push images');
check(/permissions:\s*\n\s+contents: read\s*\n\s+packages: write/.test(deployJob), 'the deploy job alone has packages: write');

console.log('\n# what CI runs\n');
check(/run: bash scripts\/check\.sh/.test(testJob), 'the test job runs scripts/check.sh');
check(/needs: test/.test(deployJob), 'deploy waits for the tests');

process.exit(fails ? 1 : 0);
