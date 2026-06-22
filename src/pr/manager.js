const fs = require('fs');
const path = require('path');
const BruvObjects = require('../core/objects');
const MergeEngine = require('../merge/engine');
const { readJson, writeJson } = require('../utils/fs');

/**
 * Native Pull Request system for bruv.
 * PRs are first-class objects, not a hacky addon.
 * Supports private PRs, reviewer management, and merging.
 */

class PRManager {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.objects = new BruvObjects(repoPath);
    this.mergeEngine = new MergeEngine(repoPath);
    this.privacyFile = path.join(repoPath, '.bruv', 'privacy.json');
  }

  create({ title, description, sourceSnapshot, targetSnapshot, author, isPrivate = false, reviewers = [] }) {
    // Verify snapshots exist
    const source = this.objects.readSnapshot(sourceSnapshot);
    const target = this.objects.readSnapshot(targetSnapshot);
    if (!source) throw new Error(`Source snapshot '${sourceSnapshot}' not found`);
    if (!target) throw new Error(`Target snapshot '${targetSnapshot}' not found`);

    const prHash = this.objects.writePR({
      title,
      description: description || '',
      sourceSnapshot,
      targetSnapshot,
      author,
      isPrivate,
      reviewers,
      status: 'open',
      comments: [],
    });

    // Set privacy
    if (isPrivate) {
      this.setVisibility(prHash.slice(0, 7), true, [author]);
    }

    return prHash;
  }

  list(status = null) {
    return this.objects.listPRs(status);
  }

  get(prId) {
    return this.objects.readPR(prId);
  }

  close(prId, closedBy) {
    const pr = this.objects.readPR(prId);
    if (!pr) throw new Error(`PR ${prId} not found`);
    if (pr.status !== 'open') throw new Error(`PR is already ${pr.status}`);

    this.objects.updatePR(pr.fullHash, { status: 'closed', closedBy, closedAt: new Date().toISOString() });
  }

  reopen(prId) {
    const pr = this.objects.readPR(prId);
    if (!pr) throw new Error(`PR ${prId} not found`);
    if (pr.status !== 'closed') throw new Error(`PR is ${pr.status}, not closed`);

    this.objects.updatePR(pr.fullHash, { status: 'open', closedBy: undefined, closedAt: undefined });
  }

  addComment(prId, author, body) {
    const pr = this.objects.readPR(prId);
    if (!pr) throw new Error(`PR ${prId} not found`);

    pr.comments.push({
      author,
      body,
      timestamp: new Date().toISOString(),
    });

    this.objects.updatePR(pr.fullHash, { comments: pr.comments });
  }

  addReviewer(prId, reviewer) {
    const pr = this.objects.readPR(prId);
    if (!pr) throw new Error(`PR ${prId} not found`);

    if (!pr.reviewers.includes(reviewer)) {
      pr.reviewers.push(reviewer);
      this.objects.updatePR(pr.fullHash, { reviewers: pr.reviewers });
    }
  }

  removeReviewer(prId, reviewer) {
    const pr = this.objects.readPR(prId);
    if (!pr) throw new Error(`PR ${prId} not found`);

    pr.reviewers = pr.reviewers.filter(r => r !== reviewer);
    this.objects.updatePR(pr.fullHash, { reviewers: pr.reviewers });
  }

  approve(prId, approver) {
    const pr = this.objects.readPR(prId);
    if (!pr) throw new Error(`PR ${prId} not found`);

    if (!pr.approvals) pr.approvals = [];
    if (!pr.approvals.includes(approver)) {
      pr.approvals.push(approver);
      this.objects.updatePR(pr.fullHash, { approvals: pr.approvals });
    }
  }

  /**
   * Merge a PR using the specified merge strategy.
   * Returns the merged commit hash.
   */
  async merge(prId, author, strategy = 'union', choices = null, signal = null) {
    const pr = this.objects.readPR(prId);
    if (!pr) throw new Error(`PR ${prId} not found`);
    if (pr.status !== 'open') throw new Error(`PR is ${pr.status}, not open`);

    const source = this.objects.readSnapshot(pr.sourceSnapshot);
    const target = this.objects.readSnapshot(pr.targetSnapshot);
    if (!source || !target) throw new Error('Source or target snapshot not found');

    const sourceTree = source.commit.tree;
    const targetTree = target.commit.tree;

    let mergedTreeHash;

    if (strategy === 'union') {
      mergedTreeHash = this.mergeEngine.unionMerge(targetTree, sourceTree, true);
    } else if (strategy === 'custom') {
      if (!choices) {
        const mergeData = this.mergeEngine.prepareCustomMerge(targetTree, sourceTree);
        return { needsResolution: true, mergeData };
      }
      const mergeData = this.mergeEngine.prepareCustomMerge(targetTree, sourceTree);
      mergedTreeHash = mergeData.resolve(choices);
    } else if (strategy === 'automated') {
      mergedTreeHash = await this.mergeEngine.automatedMerge(targetTree, sourceTree, signal);
    } else {
      throw new Error(`Unknown merge strategy: ${strategy}`);
    }

    const mergedCommitHash = this.objects.writeCommit({
      tree: mergedTreeHash,
      parents: [target.commitHash, source.commitHash],
      message: `Merge PR #${prId}: ${pr.title}`,
      author,
      metadata: { mergeType: strategy, pr: prId },
    });

    // Update target snapshot to point to merged commit
    this.objects.writeSnapshot({
      name: pr.targetSnapshot,
      commit: mergedCommitHash,
      message: `Merged PR #${prId}`,
      author,
      parent: target.commitHash,
      force: true,
    });

    // Mark PR as merged
    this.objects.updatePR(pr.fullHash, {
      status: 'merged',
      mergedBy: author,
      mergedAt: new Date().toISOString(),
      mergeCommit: mergedCommitHash,
    });

    return { mergedCommitHash, needsResolution: false };
  }

  // ---- Privacy / Sharing ----

  setVisibility(prId, isPrivate, sharedWith = []) {
    if (!fs.existsSync(this.privacyFile)) {
      writeJson(this.privacyFile, { snapshots: {}, prs: {} });
    }
    const privacy = readJson(this.privacyFile);
    if (!privacy.prs) privacy.prs = {};
    privacy.prs[prId] = { isPrivate, sharedWith };
    writeJson(this.privacyFile, privacy);
  }

  getVisibility(prId) {
    const privacy = readJson(this.privacyFile, { snapshots: {}, prs: {} });
    return privacy.prs?.[prId] || { isPrivate: false, sharedWith: [] };
  }

  shareWithUser(prId, username) {
    const vis = this.getVisibility(prId);
    if (!vis.isPrivate) {
      throw new Error('Cannot share a public PR. Make it private first.');
    }
    if (!vis.sharedWith.includes(username)) {
      vis.sharedWith.push(username);
    }
    this.setVisibility(prId, true, vis.sharedWith);
  }

  revokeAccess(prId, username) {
    const vis = this.getVisibility(prId);
    vis.sharedWith = vis.sharedWith.filter(u => u !== username);
    this.setVisibility(prId, vis.isPrivate, vis.sharedWith);
  }
}

module.exports = PRManager;
