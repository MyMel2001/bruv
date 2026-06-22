const fs = require('fs');
const path = require('path');
const BruvObjects = require('../core/objects');
const { ensureDir, writeJson, readJson } = require('../utils/fs');

/**
 * Snapshot manager for bruv.
 * Snapshots are branch-like except they can be merged with any other snapshot
 * without conflicts (union merge by default).
 */

class SnapshotManager {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.objects = new BruvObjects(repoPath);
    this.snapshotsDir = path.join(repoPath, '.bruv', 'refs', 'snapshots');
    this.privacyFile = path.join(repoPath, '.bruv', 'privacy.json');
  }

  create(name, commitHash, author, message = '', metadata = {}) {
    const existing = this.objects.readSnapshot(name);
    if (existing && !metadata.force) {
      throw new Error(`Snapshot '${name}' already exists. Use --force to overwrite.`);
    }
    const snapHash = this.objects.writeSnapshot({
      name,
      commit: commitHash,
      message: message || `Created snapshot ${name}`,
      author,
      parent: existing ? existing.commitHash : null,
      metadata,
    });
    return { name, commitHash, snapHash };
  }

  list() {
    return this.objects.listSnapshots();
  }

  get(name) {
    return this.objects.readSnapshot(name);
  }

  delete(name) {
    const refPath = path.join(this.snapshotsDir, name);
    if (fs.existsSync(refPath)) {
      fs.unlinkSync(refPath);
      return true;
    }
    return false;
  }

  /**
   * Union merge: combines files from multiple snapshots.
   * For files that exist in both, the latest change wins.
   * This is designed to be conflict-free by default.
   */
  mergeSnapshots(snapshotNames, author, message = '', metadata = {}) {
    const trees = [];
    const commitHashes = [];

    for (const name of snapshotNames) {
      const snap = this.objects.readSnapshot(name);
      if (!snap) throw new Error(`Snapshot '${name}' not found`);
      trees.push(snap.commit.tree);
      commitHashes.push(snap.commitHash);
    }

    // Union merge: combine all trees
    const mergedTree = this._unionMergeTrees(trees);
    const mergedCommitHash = this.objects.writeCommit({
      tree: mergedTree,
      parents: commitHashes,
      message: message || `Merge snapshots: ${snapshotNames.join(', ')}`,
      author,
      metadata: { ...metadata, mergeType: 'union', mergedFrom: snapshotNames },
    });

    return mergedCommitHash;
  }

  _unionMergeTrees(treeHashes) {
    const fileMap = new Map(); // filepath -> { hash, treePath }

    for (const treeHash of treeHashes) {
      this._flattenTree(treeHash, '', fileMap);
    }

    return this._buildTreeFromFileMap(fileMap);
  }

  _flattenTree(treeHash, prefix, fileMap) {
    const entries = this.objects.readTree(treeHash);
    if (!entries) return;

    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'tree') {
        this._flattenTree(entry.hash, fullPath, fileMap);
      } else {
        // Latest write wins (based on order of treeHashes, last one wins)
        fileMap.set(fullPath, { hash: entry.hash });
      }
    }
  }

  _buildTreeFromFileMap(fileMap) {
    // Group files by directory
    const dirMap = new Map();

    for (const [filePath, info] of fileMap) {
      const parts = filePath.split('/');
      const fileName = parts.pop();

      let currentDir = '';
      for (const part of parts) {
        const dirPath = currentDir ? `${currentDir}/${part}` : part;
        if (!dirMap.has(dirPath)) {
          dirMap.set(dirPath, []);
        }
        currentDir = dirPath;
      }

      const dirKey = parts.join('/');
      if (!dirMap.has(dirKey)) {
        dirMap.set(dirKey, []);
      }
      dirMap.get(dirKey).push({ name: fileName, type: 'blob', hash: info.hash });
    }

    // Build trees bottom-up
    return this._buildTreeRecursive('', dirMap);
  }

  _buildTreeRecursive(dirPath, dirMap) {
    const entries = dirMap.get(dirPath) || [];
    const subDirs = new Set();

    // Find subdirectories
    for (const [key, _] of dirMap) {
      if (key === dirPath) continue;
      if (dirPath === '' ? !key.includes('/') : key.startsWith(dirPath + '/')) {
        const rest = dirPath === '' ? key : key.slice(dirPath.length + 1);
        const subDir = rest.split('/')[0];
        if (rest.includes('/')) {
          subDirs.add(subDir);
        }
      }
    }

    for (const subDir of subDirs) {
      const subDirPath = dirPath ? `${dirPath}/${subDir}` : subDir;
      const subTreeHash = this._buildTreeRecursive(subDirPath, dirMap);
      entries.push({ name: subDir, type: 'tree', hash: subTreeHash });
    }

    return this.objects.writeTree(entries);
  }

  // ---- Privacy / Sharing ----

  setVisibility(snapshotName, isPrivate, sharedWith = []) {
    if (!fs.existsSync(this.privacyFile)) {
      writeJson(this.privacyFile, { snapshots: {}, prs: {} });
    }
    const privacy = readJson(this.privacyFile);
    if (!privacy.snapshots) privacy.snapshots = {};
    privacy.snapshots[snapshotName] = { isPrivate, sharedWith };
    writeJson(this.privacyFile, privacy);
  }

  getVisibility(snapshotName) {
    const privacy = readJson(this.privacyFile, { snapshots: {}, prs: {} });
    return privacy.snapshots?.[snapshotName] || { isPrivate: false, sharedWith: [] };
  }

  shareWithUser(snapshotName, username) {
    const vis = this.getVisibility(snapshotName);
    if (!vis.isPrivate) {
      throw new Error('Cannot share a public snapshot. Make it private first.');
    }
    if (!vis.sharedWith.includes(username)) {
      vis.sharedWith.push(username);
    }
    this.setVisibility(snapshotName, true, vis.sharedWith);
  }

  revokeAccess(snapshotName, username) {
    const vis = this.getVisibility(snapshotName);
    vis.sharedWith = vis.sharedWith.filter(u => u !== username);
    this.setVisibility(snapshotName, vis.isPrivate, vis.sharedWith);
  }
}

module.exports = SnapshotManager;
