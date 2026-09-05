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
