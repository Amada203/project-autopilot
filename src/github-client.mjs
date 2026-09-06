// Narrow GitHub client interface. The controller may only create candidate
// branches, commits, draft PRs, labels, and comments, and read repository
// metadata. Branch protection, secret, permission, and self-approval
// operations do not exist on this interface by construction.

export class FakeGithubClient {
  constructor({ defaultBranch = 'main', existingBranches = [] } = {}) {
    this.defaultBranch = defaultBranch;
    this.operations = [];
    this.existingBranches = new Set(existingBranches);
    this.pullRequests = [];
  }

  async createBranch(repositoryId, branchName, fromRef) {
    this.assertNotDefaultBranch(repositoryId, branchName);
    if (this.existingBranches.has(branchName)) {
      throw new Error(`branch already exists: ${branchName}`);
    }
    this.operations.push(['createBranch', repositoryId, branchName, fromRef]);
    this.existingBranches.add(branchName);
    return { ref: branchName };
  }

  async createCommit(repositoryId, branchName, files, message) {
    this.assertNotDefaultBranch(repositoryId, branchName);
    this.operations.push(['createCommit', repositoryId, branchName, files, message]);
    return { sha: `fake-${this.operations.length.toString().padStart(7, '0')}` };
  }

  async openPullRequest(repositoryId, { head, base, title, body, draft = true }) {
    this.assertNotDefaultBranch(repositoryId, head);
    if (base === this.defaultBranch && draft !== true) {
      throw new Error('controller may only open draft pull requests');
    }
    this.operations.push(['openPullRequest', repositoryId, head, base, title]);
    const pr = { number: this.pullRequests.length + 1, head, base, title, body, draft };
    this.pullRequests.push(pr);
    return pr;
  }

  async addLabel(repositoryId, pullNumber, label) {
    if (label === 'approved') throw new Error('self-approval is not permitted');
    this.operations.push(['addLabel', repositoryId, pullNumber, label]);
  }

  async addComment(repositoryId, pullNumber, body) {
    this.operations.push(['addComment', repositoryId, pullNumber, body]);
  }

  async readRepositoryMetadata(repositoryId) {
    this.operations.push(['readRepositoryMetadata', repositoryId]);
    return { defaultBranch: this.defaultBranch, private: true };
  }

  assertNotDefaultBranch(repositoryId, ref) {
    if (ref === this.defaultBranch || ref === 'master') {
      throw new Error(`refusing write to default branch ${ref}`);
    }
  }
}

// Minimal real adapter over the GitHub REST API. The token must be a
// same-repository token limited to contents:write + pull-requests:write.
// Merge, release, deployment, and administration endpoints do not exist
// here by construction.
export class RealGithubClient {
  constructor({ token, owner, repo, apiBase = 'https://api.github.com' }) {
    if (!token) throw new Error('RealGithubClient requires a repository token');
    this.owner = owner;
    this.repo = repo;
    this.defaultBranch = 'main';
    this.apiBase = apiBase;
    this.headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'project-autopilot',
    };
  }

  async request(method, path, body) {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`github ${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async createBranch(repositoryId, branchName, fromRef) {
    this.assertNotDefaultBranch(repositoryId, branchName);
    const source = await this.request('GET', `/repos/${repositoryId}/git/ref/heads/${fromRef}`);
    await this.request('POST', `/repos/${repositoryId}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: source.object.sha,
    });
    return { ref: branchName };
  }

  async createCommit(repositoryId, branchName, files, message) {
    this.assertNotDefaultBranch(repositoryId, branchName);
    let parentRef = await this.request('GET', `/repos/${repositoryId}/git/ref/heads/${branchName}`);
    let parentSha = parentRef.object.sha;
    for (const file of files) {
      const apiPath = file.path.split('/').map(encodeURIComponent).join('/');
      const existing = await this.request('GET', `/repos/${repositoryId}/contents/${apiPath}?ref=${branchName}`)
        .catch(() => null);
      const result = await this.request('PUT', `/repos/${repositoryId}/contents/${apiPath}`, {
        message: `${message}: ${file.path}`,
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        branch: branchName,
        sha: existing?.sha,
      });
      parentSha = result.commit.sha;
    }
    return { sha: parentSha };
  }

  async openPullRequest(repositoryId, { head, base, title, body, draft = true }) {
    this.assertNotDefaultBranch(repositoryId, head);
    return this.request('POST', `/repos/${repositoryId}/pulls`, { head, base, title, body, draft });
  }

  async addLabel(repositoryId, pullNumber, label) {
    if (label === 'approved') throw new Error('self-approval is not permitted');
    await this.request('POST', `/repos/${repositoryId}/issues/${pullNumber}/labels`, { labels: [label] });
  }

  async addComment(repositoryId, pullNumber, body) {
    await this.request('POST', `/repos/${repositoryId}/issues/${pullNumber}/comments`, { body });
  }

  async readRepositoryMetadata(repositoryId) {
    const data = await this.request('GET', `/repos/${repositoryId}`);
    this.defaultBranch = data.default_branch;
    return { defaultBranch: data.default_branch, private: data.private };
  }

  assertNotDefaultBranch(repositoryId, ref) {
    if (ref === this.defaultBranch || ref === 'master') {
      throw new Error(`refusing write to default branch ${ref}`);
    }
  }
}
