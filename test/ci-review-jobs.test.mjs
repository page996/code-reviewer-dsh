/**
 * Contract tests for the agent-job supervisor helpers. These are the rules that
 * stop a model call from hanging the panel forever (oversized prompt, missing
 * deadline, zombie "running" record after a Host restart).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyJobUpdate,
  classifyFailure,
  HARD_PROMPT_CAP_BYTES,
  isOverdue,
  MAX_JOB_TIMEOUT_MS,
  promptBudgetFor,
  promptBytes,
  summarizeJobs,
  sweepInterrupted,
  sweepOverdue,
  timeoutFor,
  truncatePrompt,
} from '../plugins/ci-review/lib/agent-jobs.mjs';

const bigPrompt = (chars) => [{ type: 'text', text: 'x'.repeat(chars) }];

test('prompt under budget is passed through untouched', () => {
  const parts = bigPrompt(100);
  const result = truncatePrompt(parts, 4096);
  assert.equal(result.truncated, false);
  assert.equal(result.bytes, result.originalBytes);
  assert.equal(result.parts, parts);
});

test('oversized prompt is truncated under budget with an explicit marker', () => {
  const parts = bigPrompt(50_000);
  const original = promptBytes(parts);
  const result = truncatePrompt(parts, 4096);
  assert.equal(result.truncated, true);
  assert.equal(result.originalBytes, original);
  assert.ok(result.bytes <= 4096, `bytes ${result.bytes} must fit the budget`);
  assert.ok(result.droppedBytes > 0);
  const text = result.parts.map((part) => part.text ?? part).join('');
  assert.match(text, /\[ci-review\] 提示词超出预算已截断/);
  assert.ok(text.length < 50_000);
});

test('multi-part prompt keeps every part but shrinks the largest one', () => {
  const parts = [
    { type: 'text', text: 'system instructions ' },
    { type: 'text', text: 'y'.repeat(30_000) },
    { type: 'text', text: ' tail' },
  ];
  const result = truncatePrompt(parts, 8192);
  assert.ok(result.parts.length >= 1);
  assert.ok(result.bytes <= 8192);
  assert.ok(String(result.parts[0].text ?? result.parts[0]).includes('system instructions'));
});

test('per-kind budgets and timeouts honour config overrides but stay clamped', () => {
  assert.equal(promptBudgetFor('group', {}), 120 * 1024);
  assert.equal(promptBudgetFor('group', { ciReview: { promptBudgetBytes: { group: 2048 } } }), 2048);
  assert.equal(promptBudgetFor('group', { ciReview: { promptBudgetBytes: { group: 10 * 1024 * 1024 } } }), HARD_PROMPT_CAP_BYTES);
  assert.equal(timeoutFor('group', {}), 8 * 60 * 1000);
  assert.equal(timeoutFor('group', { ciReview: { jobTimeoutMs: { group: 60_000 } } }), 60_000);
  assert.equal(timeoutFor('group', { ciReview: { jobTimeoutMs: { group: 10 * 60 * 60 * 1000 } } }), MAX_JOB_TIMEOUT_MS);
  assert.equal(timeoutFor('group', { ciReview: { jobTimeoutMs: { group: 1 } } }), 15_000);
});

test('isOverdue only fires for running jobs past their deadline', () => {
  const now = Date.now();
  const running = { status: 'running', startedAt: new Date(now - 1000).toISOString(), timeoutMs: 5000 };
  assert.equal(isOverdue(running, now, 0), false);
  assert.equal(isOverdue(running, now + 5000, 0), true);
  assert.equal(isOverdue({ ...running, status: 'completed' }, now + 999_999, 0), false);
  assert.equal(isOverdue({ ...running, deadlineAt: now - 1 }, now, 0), true);
});

test('sweepOverdue marks zombie running jobs failed(timeout) and leaves fresh ones', () => {
  const now = Date.now();
  const jobs = {
    a: { id: 'a', kind: 'group', status: 'running', startedAt: new Date(now - 60_000).toISOString(), timeoutMs: 1000 },
    b: { id: 'b', kind: 'review', status: 'running', startedAt: new Date(now).toISOString(), timeoutMs: 60_000 },
    c: { id: 'c', kind: 'audit', status: 'completed', startedAt: new Date(now - 9_000_000).toISOString(), timeoutMs: 1000 },
  };
  const result = sweepOverdue(jobs, { now, graceMs: 0 });
  assert.deepEqual(result.swept, ['a']);
  assert.equal(result.jobs.a.status, 'failed');
  assert.equal(result.jobs.a.errorCode, 'timeout');
  assert.equal(result.jobs.b.status, 'running');
  assert.equal(result.jobs.c.status, 'completed');
});

test('sweepInterrupted fails every persisted running job after a host restart', () => {
  const jobs = {
    a: { id: 'a', kind: 'group', status: 'running', startedAt: new Date().toISOString() },
    b: { id: 'b', kind: 'verify', status: 'failed', error: 'earlier' },
  };
  const result = sweepInterrupted(jobs);
  assert.deepEqual(result.interrupted, ['a']);
  assert.equal(result.jobs.a.errorCode, 'interrupted');
  assert.equal(result.jobs.b.error, 'earlier');
});

test('applyJobUpdate refuses writes from superseded jobs and terminal states', () => {
  const jobs = { a: { id: 'a', status: 'running' } };
  assert.equal(applyJobUpdate(jobs, 'a', { status: 'completed' }, { expectedId: 'old' }).applied, false);
  assert.equal(applyJobUpdate(jobs, 'a', { status: 'completed' }, { expectedId: 'a' }).applied, true);
  const terminal = { a: { id: 'a', status: 'failed' } };
  const refused = applyJobUpdate(terminal, 'a', { status: 'completed' }, { onlyStatuses: ['running'] });
  assert.equal(refused.applied, false);
  assert.equal(terminal.a.status, 'failed');
});

test('classifyFailure separates timeouts from generic errors', () => {
  assert.equal(classifyFailure(new Error('task timeout')).code, 'timeout');
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(classifyFailure(abort).code, 'timeout');
  assert.equal(classifyFailure(new Error('spawn failed')).code, 'error');
});

test('summarizeJobs reports running/overdue counts, ages and recent failures', () => {
  const now = Date.now();
  const jobs = {
    a: { id: 'a', kind: 'group', status: 'running', startedAt: new Date(now - 30_000).toISOString(), timeoutMs: 60_000 },
    b: { id: 'b', kind: 'verify', status: 'failed', errorCode: 'timeout', error: 'boom', finishedAt: new Date(now - 1000).toISOString() },
    c: { id: 'c', kind: 'group', status: 'completed', startedAt: new Date(now - 5000).toISOString(), finishedAt: new Date(now).toISOString() },
  };
  const summary = summarizeJobs(jobs, { now, graceMs: 0 });
  assert.equal(summary.total, 3);
  assert.equal(summary.running, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.completed, 1);
  assert.equal(summary.overdue, 0);
  assert.equal(summary.oldestRunningSeconds, 30);
  assert.equal(summary.byKind.group.running, 1);
  assert.equal(summary.recentFailures.length, 1);
  assert.equal(summary.recentFailures[0].errorCode, 'timeout');
});
