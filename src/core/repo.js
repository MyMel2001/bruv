const fs = require('fs');
const path = require('path');
const BruvObjects = require('./objects');
const SnapshotManager = require('../snapshot/manager');
const PRManager = require('../pr/manager');
const MergeEngine = require('../merge/engine');
const { scanFiles, aiScanFiles } = require('../security/scanner');
const { loadConfig } = require('../config');
const { ensureDir, readJson, writeJson, listDirRecursive } = require('../utils/fs');
const { shortHash } = require('../utils/hash');

/**
 * Core repository for bruv.
 * Orchestrates all VCS operations: init, add, commit, snapshot, tag, merge, push, pull, etc.
 */

class BruvRepo {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.bruvDir = path.join(repoPath, '.bruv');
    this.objects = new BruvObjects(repoPath);
    this.snapshots = new SnapshotManager(repoPath);
    this.prs = new PRManager(repoPath);
    this.mergeEngine = new MergeEngine(repoPath);
    this.config = loadConfig();
  }

  // ---- Repository management ----

  static isInitialized(dirPath) {
    return fs.existsSync(path.join(dirPath, '.bruv'));
  }

  static findRepo(startPath) {
    let current = path.resolve(startPath);
    for (;;) {
      if (BruvRepo.isInitialized(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  static init(dirPath, options = {}) {
    const bruvDir = path.join(dirPath, '.bruv');
    if (fs.existsSync(bruvDir)) {
      throw new Error('Repository already initialized.');
    }

    ensureDir(bruvDir);
    ensureDir(path.join(bruvDir, 'objects'));
    ensureDir(path.join(bruvDir, 'refs', 'tags'));
    ensureDir(path.join(bruvDir, 'refs', 'snapshots'));
    ensureDir(path.join(bruvDir, 'refs', 'prs'));

    // Create initial config
    writeJson(path.join(bruvDir, 'config.json'), {
      isPrivate: options.private || false,
      defaultRemote: options.remote || null,
      created: new Date().toISOString(),
    });

    // Create .bruvignore if not exists
    const ignorePath = path.join(dirPath, '.bruvignore');
    if (!fs.existsSync(ignorePath)) {
      fs.writeFileSync(ignorePath, [
        'node_modules/',
        '.env',
        '.env.*',
        '*.pem',
        '*.key',
        'credentials.json',
        'secrets.yml',
        '.DS_Store',
        'dist/',
        'build/',
        '.next/',
        '.bruv/',
      ].join('\n') + '\n', 'utf8');
    }

    // Create initial commit (empty tree)
    const repo = new BruvRepo(dirPath);
    const emptyTree = repo.objects.writeTree([]);
    const config = loadConfig();
    const author = options.author || config.BRUV_USER_NAME || 'unknown';
    const email = options.email || config.BRUV_USER_EMAIL || '';

    const initialCommit = repo.objects.writeCommit({
      tree: emptyTree,
      parents: [],
      message: options.message || 'Initial commit',
      author: email ? `${author} <${email}>` : author,
    });

    // Create main snapshot
    repo.objects.writeSnapshot({
      name: 'main',
      commit: initialCommit,
      message: 'Initial snapshot',
      author: email ? `${author} <${email}>` : author,
    });

    // Set HEAD to main
    repo.objects.setHead('snapshot', 'main');

    return repo;
  }

  // ---- Staging area ----

  _stagingPath() {
    return path.join(this.bruvDir, 'staging.json');
  }

  _loadStaging() {
    return readJson(this._stagingPath(), { files: {}, removed: [] });
  }

  _saveStaging(staging) {
    writeJson(this._stagingPath(), staging);
  }

  add(files, options = {}) {
    const staging = this._loadStaging();
    const workingDir = this.repoPath;

    // Resolve relative to repo root
    const resolvedFiles = [];
    if (files.length === 1 && files[0] === '.') {
      // Add all files
      const allFiles = listDirRecursive(workingDir, ['.bruv', '.git', 'node_modules', 'dist', 'build']);
      resolvedFiles.push(...allFiles);
    } else {
      for (const f of files) {
        const full = path.resolve(workingDir, f);
        const rel = path.relative(workingDir, full);
        if (fs.statSync(full).isDirectory()) {
          const dirFiles = listDirRecursive(full, []);
          resolvedFiles.push(...dirFiles.map(df => path.join(rel, df)));
        } else {
          resolvedFiles.push(rel);
        }
      }
    }

    // Security scan
    const danger = options.danger || this.config.BRUV_DANGER_FLAG_DEFAULT;
    if (!danger) {
      // Always run basic scan for .env-like files
      const scanResult = scanFiles(resolvedFiles, workingDir, options);
      
      // Block .env files regardless (even with AI)
      for (const blocked of scanResult.blocked) {
        const idx = resolvedFiles.indexOf(blocked.file);
        if (idx !== -1) resolvedFiles.splice(idx, 1);
      }

      if (scanResult.blocked.length > 0) {
        console.error('\n⚠️  BLOCKED: The following files look like credential files:');
        for (const b of scanResult.blocked) {
          console.error(`   ${b.file} - ${b.reason}`);
        }
        console.error('   Use --danger flag to override (NOT RECOMMENDED).\n');
      }

      if (scanResult.suspicious.length > 0) {
        console.warn('\n⚠️  SUSPICIOUS: The following files may contain secrets:');
        for (const s of scanResult.suspicious) {
          console.warn(`   ${s} - High entropy content`);
        }
        console.warn('   Review these files or use --danger to force-add.\n');
      }

      // Use safe files only
      for (const file of scanResult.safe) {
        const fullPath = path.join(workingDir, file);
        const blobHash = this.objects.writeFileBlob(fullPath);
        staging.files[file] = { hash: blobHash, addedAt: new Date().toISOString() };
      }
    } else {
      // --danger flag: add everything, but warn
      console.warn('\n⚠️  --danger flag used. ALL files will be added, including potential credential files.');
      for (const file of resolvedFiles) {
        const fullPath = path.join(workingDir, file);
        if (fs.existsSync(fullPath)) {
          const blobHash = this.objects.writeFileBlob(fullPath);
          staging.files[file] = { hash: blobHash, addedAt: new Date().toISOString() };
        }
      }
    }

    // Remove from "removed" list if re-added
    staging.removed = staging.removed.filter(f => !resolvedFiles.includes(f));
    this._saveStaging(staging);
    return resolvedFiles.length;
  }

  rm(files) {
    const staging = this._loadStaging();
    for (const file of files) {
      delete staging.files[file];
      if (!staging.removed.includes(file)) {
        staging.removed.push(file);
      }
    }
    this._saveStaging(staging);
  }

  status() {
    const staging = this._loadStaging();
    const head = this.objects.resolveHead();
    const workingDir = this.repoPath;

    const result = {
      snapshot: head?.ref || 'main',
      staged: Object.keys(staging.files),
      removed: staging.removed,
      modified: [],
      untracked: [],
    };

    // Get tracked files from HEAD
    const trackedFiles = new Set();
    if (head?.commit?.tree) {
      const treeEntries = this._flattenTree(head.commit.tree);
      for (const [filePath] of treeEntries) {
        trackedFiles.add(filePath);
      }
    }

    // Check working directory
    const allFiles = listDirRecursive(workingDir, ['.bruv', '.git', 'node_modules', 'dist', 'build']);
    for (const file of allFiles) {
      if (staging.files[file]) continue; // Already staged
      if (trackedFiles.has(file)) {
        // Check if modified
        const fullPath = path.join(workingDir, file);
        const blobHash = this.objects.writeFileBlob(fullPath);
        const treeEntries = head?.commit?.tree ? this._flattenTree(head.commit.tree) : new Map();
        const tracked = treeEntries.get(file);
        if (tracked && tracked.hash !== blobHash) {
          result.modified.push(file);
        }
      } else {
        result.untracked.push(file);
      }
    }

    // Also check for deleted tracked files
    for (const filePath of trackedFiles) {
      const fullPath = path.join(workingDir, filePath);
      if (!fs.existsSync(fullPath) && !staging.removed.includes(filePath)) {
        result.removed.push(filePath);
      }
    }

    return result;
  }

  // ---- Commit ----

  commit(message, options = {}) {
    const staging = this._loadStaging();
    const head = this.objects.resolveHead();

    if (Object.keys(staging.files).length === 0 && staging.removed.length === 0) {
      throw new Error('Nothing to commit. Stage files first with `bruv add`.');
    }

    // Build tree from HEAD commit + staged changes
    let baseTree = {};
    if (head?.commit?.tree) {
      const entries = this._flattenTree(head.commit.tree);
      for (const [filePath, info] of entries) {
        baseTree[filePath] = info.hash;
      }
    }

    // Apply staged additions
    for (const [filePath, info] of Object.entries(staging.files)) {
      baseTree[filePath] = info.hash;
    }

    // Apply staged removals
    for (const filePath of staging.removed) {
      delete baseTree[filePath];
    }

    // Build tree from merged file map
    const treeHash = this._buildTreeFromFileMap(baseTree);

    const parentHash = head?.commitHash || null;
    const config = loadConfig();
    const author = options.author || config.BRUV_USER_NAME || 'unknown';
    const email = options.email || config.BRUV_USER_EMAIL || '';

    const commitHash = this.objects.writeCommit({
      tree: treeHash,
      parents: parentHash ? [parentHash] : [],
      message,
      author: email ? `${author} <${email}>` : author,
    });

    // Update current snapshot to point to new commit
    const currentSnapshot = head?.ref || 'main';
    this.objects.writeSnapshot({
      name: currentSnapshot,
      commit: commitHash,
      message: `Commit: ${message}`,
      author: email ? `${author} <${email}>` : author,
      parent: parentHash,
      force: true,
    });

    // Clear staging
    this._saveStaging({ files: {}, removed: [] });

    return { commitHash, treeHash };
  }

  // ---- Tags ----

  tag(name, options = {}) {
    const head = this.objects.resolveHead();
    if (!head) throw new Error('No commits yet. Make a commit first.');

    const commitHash = head.commitHash;
    const config = loadConfig();
    const author = options.author || config.BRUV_USER_NAME || 'unknown';

    const tagHash = this.objects.writeTag({
      name,
      commit: commitHash,
      message: options.message || `Tag ${name}`,
      author,
    });

    return { name, commitHash, tagHash };
  }

  // ---- Working with snapshots ----

  snapshot(name, options = {}) {
    const head = this.objects.resolveHead();
    if (!head) throw new Error('No commits yet.');

    const commitHash = options.commit || head.commitHash;
    const config = loadConfig();
    const author = options.author || config.BRUV_USER_NAME || 'unknown';

    return this.snapshots.create(name, commitHash, author, options.message, options);
  }

  switchSnapshot(name) {
    const snap = this.objects.readSnapshot(name);
    if (!snap) throw new Error(`Snapshot '${name}' not found`);

    this.objects.setHead('snapshot', name);

    // Checkout the snapshot's tree to working directory
    const treeHash = snap.commit.tree;
    // We don't wipe the working directory - we overlay instead
    this.objects.checkoutTree(treeHash, this.repoPath);

    return snap;
  }

  // ---- Merge ----

  async merge(sourceSnapshot, targetSnapshot, options = {}) {
    const strategy = options.strategy || 'union';
    const config = loadConfig();
    const author = options.author || config.BRUV_USER_NAME || 'unknown';

    const source = this.objects.readSnapshot(sourceSnapshot);
    const target = this.objects.readSnapshot(targetSnapshot || this.objects.getHead()?.name);
    if (!source || !target) throw new Error('Source or target snapshot not found');

    if (strategy === 'union') {
      const mergedTreeHash = this.mergeEngine.unionMerge(target.commit.tree, source.commit.tree, true);
      const mergeCommitHash = this.objects.writeCommit({
        tree: mergedTreeHash,
        parents: [target.commitHash, source.commitHash],
        message: options.message || `Merge ${sourceSnapshot} into ${targetSnapshot || target.name}`,
        author,
        metadata: { mergeType: 'union' },
      });

      // Update target snapshot
      this.objects.writeSnapshot({
        name: target.name,
        commit: mergeCommitHash,
        message: `Merge ${sourceSnapshot}`,
        author,
        parent: target.commitHash,
        force: true,
      });

      // Checkout merged tree
      this.objects.checkoutTree(mergedTreeHash, this.repoPath);

      return { mergeCommitHash, strategy: 'union', conflicts: [] };
    }

    if (strategy === 'custom') {
      const mergeData = this.mergeEngine.prepareCustomMerge(target.commit.tree, source.commit.tree);
      return { needsResolution: true, conflicts: mergeData.conflicts, mergeData };
    }

    if (strategy === 'automated') {
      const mergedTreeHash = await this.mergeEngine.automatedMerge(target.commit.tree, source.commit.tree);
      const mergeCommitHash = this.objects.writeCommit({
        tree: mergedTreeHash,
        parents: [target.commitHash, source.commitHash],
        message: options.message || `Auto-merge ${sourceSnapshot} into ${target.name}`,
        author,
        metadata: { mergeType: 'automated' },
      });

      this.objects.writeSnapshot({
        name: target.name,
        commit: mergeCommitHash,
        message: `Auto-merge ${sourceSnapshot}`,
        author,
        parent: target.commitHash,
        force: true,
      });

      this.objects.checkoutTree(mergedTreeHash, this.repoPath);

      return { mergeCommitHash, strategy: 'automated', conflicts: [] };
    }

    throw new Error(`Unknown merge strategy: ${strategy}`);
  }

  // ---- Log ----

  log(maxCount = 50) {
    const head = this.objects.resolveHead();
    if (!head) return [];
    return this.objects.getCommitHistory(head.commitHash, maxCount);
  }

  // ---- Diff ----

  diff(options = {}) {
    const staging = this._loadStaging();
    const head = this.objects.resolveHead();
    const workingDir = this.repoPath;

    const diffs = [];

    // Staged changes vs HEAD
    const baseTree = {};
    if (head?.commit?.tree) {
      const entries = this._flattenTree(head.commit.tree);
      for (const [filePath, info] of entries) {
        baseTree[filePath] = info.hash;
      }
    }

    for (const [file, info] of Object.entries(staging.files)) {
      const oldHash = baseTree[file];
      if (oldHash && oldHash !== info.hash) {
        diffs.push({ file, type: 'modified', oldHash, newHash: info.hash });
      } else if (!oldHash) {
        diffs.push({ file, type: 'added', newHash: info.hash });
      }
    }

    for (const file of staging.removed) {
      if (baseTree[file]) {
        diffs.push({ file, type: 'deleted', oldHash: baseTree[file] });
      }
    }

    return diffs;
  }

  // ---- Clone / Push / Pull ----

  async push(options = {}) {
    const auth = require('../auth/manager');
    const authMgr = new auth();
    if (!authMgr.isAuthenticated()) {
      throw new Error('Not authenticated. Run `bruv auth` first.');
    }

    const token = authMgr.getToken();
    const remoteUrl = options.remote || this._getRemoteUrl();
    if (!remoteUrl) throw new Error('No remote configured. Use `bruv remote add <url>` first.');

    // Security scan before push
    const staging = this._loadStaging();
    const head = this.objects.resolveHead();
    if (!head) throw new Error('Nothing to push. Make a commit first.');

    const filesToPush = head.commit?.tree ? 
      Array.from(this._flattenTree(head.commit.tree).keys()) : [];

    const scanResult = scanFiles(filesToPush, this.repoPath, options);
    if (scanResult.blocked.length > 0 && !options.danger) {
      console.error('\n⚠️  PUSH BLOCKED: The following credential files would be pushed:');
      for (const b of scanResult.blocked) {
        console.error(`   ${b.file} - ${b.reason}`);
      }
      console.error('   Use --danger flag to override (NOT RECOMMENDED).\n');
      throw new Error('Push blocked due to potential credential files.');
    }

    // Push to remote API
    const apiUrl = remoteUrl;
    try {
      const response = await fetch(`${apiUrl}/repo/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          repoName: path.basename(this.repoPath),
          snapshot: this.objects.getHead()?.ref,
          commitHash: head.commitHash,
          isPrivate: readJson(path.join(this.bruvDir, 'config.json'))?.isPrivate || false,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `Push failed (${response.status})`);
      }

      return await response.json();
    } catch (e) {
      if (e.code === 'ECONNREFUSED') {
        throw new Error(`Cannot connect to remote at ${apiUrl}`);
      }
      throw e;
    }
  }

  async pull(options = {}) {
    const auth = require('../auth/manager');
    const authMgr = new auth();
    if (!authMgr.isAuthenticated()) {
      throw new Error('Not authenticated. Run `bruv auth` first.');
    }

    const token = authMgr.getToken();
    const remoteUrl = options.remote || this._getRemoteUrl();
    if (!remoteUrl) throw new Error('No remote configured.');

    const apiUrl = remoteUrl;
    try {
      const response = await fetch(`${apiUrl}/repo/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          repoName: path.basename(this.repoPath),
          snapshot: this.objects.getHead()?.ref,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `Pull failed (${response.status})`);
      }

      return await response.json();
    } catch (e) {
      if (e.code === 'ECONNREFUSED') {
        throw new Error(`Cannot connect to remote at ${apiUrl}`);
      }
      throw e;
    }
  }

  async clone(remoteUrl, destPath, options = {}) {
    const auth = require('../auth/manager');
    const authMgr = new auth();

    const token = authMgr.getToken();
    try {
      const response = await fetch(`${remoteUrl}/repo/clone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ repoName: path.basename(destPath) }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `Clone failed (${response.status})`);
      }

      const data = await response.json();

      // Initialize local repo
      BruvRepo.init(destPath, options);
      const repo = new BruvRepo(destPath);

      // Set remote
      repo.addRemote('origin', remoteUrl);

      return repo;
    } catch (e) {
      if (e.code === 'ECONNREFUSED') {
        throw new Error(`Cannot connect to remote at ${remoteUrl}`);
      }
      throw e;
    }
  }

  // ---- Remotes ----

  addRemote(name, url) {
    const remotesFile = path.join(this.bruvDir, 'remotes.json');
    const remotes = readJson(remotesFile, {});
    remotes[name] = url;
    writeJson(remotesFile, remotes);
  }

  removeRemote(name) {
    const remotesFile = path.join(this.bruvDir, 'remotes.json');
    const remotes = readJson(remotesFile, {});
    delete remotes[name];
    writeJson(remotesFile, remotes);
  }

  listRemotes() {
    const remotesFile = path.join(this.bruvDir, 'remotes.json');
    return readJson(remotesFile, {});
  }

  _getRemoteUrl() {
    const remotes = this.listRemotes();
    return remotes.origin || remotes.upstream || Object.values(remotes)[0] || null;
  }

  // ---- Repo config ----

  setConfig(key, value) {
    const configFile = path.join(this.bruvDir, 'config.json');
    const config = readJson(configFile, {});
    config[key] = value;
    writeJson(configFile, config);
  }

  getConfig() {
    return readJson(path.join(this.bruvDir, 'config.json'), {});
  }

  // ---- Helpers ----

  _flattenTree(treeHash, prefix = '') {
    const result = new Map();
    const entries = this.objects.readTree(treeHash);
    if (!entries) return result;

    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'tree') {
        const subMap = this._flattenTree(entry.hash, fullPath);
        for (const [p, info] of subMap) {
          result.set(p, info);
        }
      } else {
        result.set(fullPath, { hash: entry.hash });
      }
    }
    return result;
  }

  _buildTreeFromFileMap(fileMap) {
    const dirMap = new Map();

    for (const [filePath, hash] of Object.entries(fileMap)) {
      const parts = filePath.split('/');
      const fileName = parts.pop();
      const dirKey = parts.join('/');
      if (!dirMap.has(dirKey)) dirMap.set(dirKey, []);
      dirMap.get(dirKey).push({ name: fileName, type: 'blob', hash });
    }

    return this._buildTreeRecursive('', dirMap);
  }

  _buildTreeRecursive(dirPath, dirMap) {
    const entries = dirMap.get(dirPath) || [];
    const subDirs = new Set();

    for (const key of dirMap.keys()) {
      if (key === dirPath) continue;
      if (dirPath === '') {
        if (key.includes('/')) subDirs.add(key.split('/')[0]);
      } else if (key.startsWith(dirPath + '/')) {
        const rest = key.slice(dirPath.length + 1);
        if (rest.includes('/')) subDirs.add(rest.split('/')[0]);
      }
    }

    for (const subDir of subDirs) {
      const subDirPath = dirPath ? `${dirPath}/${subDir}` : subDir;
      const subTreeHash = this._buildTreeRecursive(subDirPath, dirMap);
      entries.push({ name: subDir, type: 'tree', hash: subTreeHash });
    }

    return this.objects.writeTree(entries);
  }
}

module.exports = BruvRepo;
