import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeGithubClient, RealGithubClient } from '../src/github-client.mjs';

// Interface conformance: both clients must satisfy the same contract —
// default-branch writes refuse, self-approval refuses, and operations map
// to the expected effects. The real client is exercised against a stubbed
// fetch so the whole contract runs offline.

const CONTRACT = {
  async createsBranchAndDraftPr(client, recorder) {
    await client.createBranch('o/r', 'autopilot/x-1', 'main');
    await client.createCommit('o/r', 'autopilot/x-1', [{ path: 'src/a.ts', content: 'x' }], 'm');
    const pr = await client.openPullRequest('o/r', {
      head: 'autopilot/x-1', base: 'main', title: 't', body: 'b', draft: true,
    });
    await client.addLabel('o/r', pr.number ?? 1, 'risk-l');
    assert.equal(recorder.has('createBranch'), true);
    assert.equal(recorder.has('createCommit'), true);
    assert.equal(recorder.has('openPullRequest'), true);
  },
  async refusesDefaultBranch(client) {
    await assert.rejects(client.createBranch('o/r', 'main', 'main'), /default branch/);
    await assert.rejects(client.openPullRequest('o/r', {
      head: 'main', base: 'main', title: 't', body: 'b',
    }), /default branch/);
  },
  async refusesSelfApproval(client, prNumber = 1) {
    await assert.rejects(client.addLabel('o/r', prNumber, 'approved'), /self-approval/);
  },
};

test('FakeGithubClient satisfies the client contract', async () => {
  const client = new FakeGithubClient();
  const recorder = new Set();
  for (const name of ['createBranch', 'createCommit', 'openPullRequest', 'addLabel']) {
    const original = client[name].bind(client);
    client[name] = async (...args) => {
      recorder.add(name);
      return original(...args);
    };
  }
  await CONTRACT.createsBranchAndDraftPr(client, recorder);
  await CONTRACT.refusesDefaultBranch(client);
  await CONTRACT.refusesSelfApproval(client);
});

test('RealGithubClient satisfies the client contract against stubbed fetch', async () => {
  const calls = [];
  const respond = (method, path) => {
    calls.push([method, path]);
    if (method === 'GET' && path.includes('/git/ref/heads/main')) {
      return { object: { sha: 'abc123' } };
    }
    if (method === 'GET' && path.includes('/git/ref/heads/autopilot/')) {
      return { object: { sha: 'def456' } };
    }
    if (method === 'GET' && path.includes('/contents/') && !path.includes('?')) {
      return { sha: 'filesha' };
    }
    if (method === 'PUT' && path.includes('/contents/')) {
      return { commit: { sha: `commit-${calls.length}` } };
    }
    if (method === 'POST' && path.endsWith('/pulls')) {
      return { number: 7 };
    }
    if (method === 'GET' && path === '/repos/o/r') {
      return { default_branch: 'main', private: true };
    }
    return {};
  };
  globalThis.fetch = async (url, options = {}) => {
    const path = url.replace('https://api.github.com', '');
    const body = respond(options.method ?? 'GET', path.split('?')[0]);
    return { ok: true, status: 200, json: async () => body };
  };

  const client = new RealGithubClient({ token: 't', owner: 'o', repo: 'r' });
  const methods = new Set();
  const wrap = (name) => {
    const original = client[name].bind(client);
    client[name] = async (...args) => {
      methods.add(name);
      return original(...args);
    };
  };
  for (const name of ['createBranch', 'createCommit', 'openPullRequest', 'addLabel']) wrap(name);
  await CONTRACT.createsBranchAndDraftPr(client, methods);

  assert.ok(calls.some(([m, p]) => m === 'POST' && p === '/repos/o/r/git/refs'));
  assert.ok(calls.some(([m, p]) => m === 'POST' && p === '/repos/o/r/pulls'));
  assert.ok(calls.some(([m, p]) => m === 'POST' && p === '/repos/o/r/issues/7/labels'));

  await CONTRACT.refusesDefaultBranch(client);
  await CONTRACT.refusesSelfApproval(client, 7);

  const meta = await client.readRepositoryMetadata('o/r');
  assert.equal(meta.defaultBranch, 'main');
});
