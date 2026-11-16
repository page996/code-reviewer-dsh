/**
 * eval.mjs — case regression evaluator (CONTRACT §11).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evalCase, loadCase } from '../lib/eval.mjs';

function tmpDir(prefix = 'review-eval-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function finding(overrides = {}) {
  return {
    file: 'lib/a.mjs',
    startLine: 10,
    endLine: 12,
    category: 'correctness',
    severity: 'major',
    problem: 'off-by-one in loop bound',
    status: 'real',
    ...overrides,
  };
}

function makeCase({ findings, dispositions }) {
  const dir = tmpDir('review-case-');
  writeJson(path.join(dir, 'findings.json'), { schemaVersion: 1, findings });
  writeJson(path.join(dir, 'dispositions.json'), dispositions);
  return dir;
}

function makeRun(findings) {
  const dir = tmpDir('review-run-');
  writeJson(path.join(dir, 'aggregate.json'), { schemaVersion: 1, runId: 'run-test', findings });
  return dir;
}

const accepted = finding();
const rejected = finding({
  file: 'lib/b.mjs',
  startLine: 21,
  category: 'docs',
  severity: 'minor',
  problem: 'naming nit in helper',
});

test('eval: accepted finding still reported -> pass', () => {
  const caseDir = makeCase({ findings: [accepted], dispositions: [] });
  const runDir = makeRun([accepted]);
  const result = evalCase({ caseDir, runDir });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.exitCode, 0);
  assert.equal(result.counts.matched, 1);
  assert.equal(result.counts.missed, 0);
  assert.equal(result.counts.newFindings, 0);
});

test('eval: accepted finding missing -> recall regression (exit 2)', () => {
  const caseDir = makeCase({ findings: [accepted], dispositions: [] });
  const runDir = makeRun([]);
  const result = evalCase({ caseDir, runDir });
  assert.equal(result.verdict, 'regress');
  assert.equal(result.exitCode, 2);
  assert.equal(result.counts.missed, 1);
  assert.equal(result.missed[0].file, 'lib/a.mjs');
});

test('eval: rejected finding reported again -> precision regression (exit 2)', () => {
  const caseDir = makeCase({
    findings: [accepted, rejected],
    dispositions: [{ file: 'lib/b.mjs', category: 'docs', disposition: 'rejected', reason: 'nit' }],
  });
  const runDir = makeRun([accepted, rejected]);
  const result = evalCase({ caseDir, runDir });
  assert.equal(result.verdict, 'regress');
  assert.equal(result.counts.noiseStillReported, 1);
  assert.equal(result.noiseStillReported[0].file, 'lib/b.mjs');
});

test('eval: fixed finding that is still reported -> stale regression (exit 2)', () => {
  const caseDir = makeCase({
    findings: [accepted],
    dispositions: [{ file: 'lib/a.mjs', category: 'correctness', disposition: 'fixed', reason: 'patched in #42' }],
  });
  const runDir = makeRun([accepted]);
  const result = evalCase({ caseDir, runDir });
  assert.equal(result.verdict, 'regress');
  assert.equal(result.counts.stale, 1);
});

test('eval: new findings are informational, not regressions', () => {
  const caseDir = makeCase({ findings: [accepted], dispositions: [] });
  const runDir = makeRun([accepted, finding({ file: 'lib/c.mjs', startLine: 5, problem: 'new issue elsewhere' })]);
  const result = evalCase({ caseDir, runDir });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.counts.newFindings, 1);
  assert.equal(result.newFindings[0].file, 'lib/c.mjs');
});

test('eval: disposition by explicit fingerprint wins over file/title matching', () => {
  const caseDir = makeCase({
    findings: [accepted],
    dispositions: [
      {
        file: 'lib/other.mjs',
        fingerprint: 'deadbeef',
        disposition: 'ignored',
        reason: 'must never match by file',
      },
    ],
  });
  const runDir = makeRun([]);
  // No matching fingerprint on the finding -> falls back to the default `accepted`,
  // so the missing finding is a regression rather than being silenced by the disposition.
  const result = evalCase({ caseDir, runDir });
  assert.equal(result.counts.missed, 1);
  assert.equal(result.counts.noiseStillReported, 0);
});

test('eval: invalid disposition value is a schema error', () => {
  const caseDir = makeCase({
    findings: [accepted],
    dispositions: [{ file: 'lib/a.mjs', disposition: 'maybe' }],
  });
  assert.throws(() => loadCase(caseDir), /invalid disposition/);
});

test('eval: missing case directory is a usage error', () => {
  assert.throws(() => evalCase({ caseDir: path.join(os.tmpdir(), 'definitely-missing-case-dir'), runDir: tmpDir() }), /case directory not found/);
});
