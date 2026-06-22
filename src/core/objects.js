const fs = require('fs');
const path = require('path');
const { hashBuffer, hashString, hashObject, shortHash } = require('../utils/hash');
const { ensureDir } = require('../utils/fs');

/**
 * Core object model for bruv.
 * All objects are content-addressable (SHA-256), stored in .bruv/objects/
 *
 * Object types:
 * - blob: raw file content
 * - tree: directory representation (maps names to blob/tree hashes)
 * - commit: a point in history (points to a tree, has parent(s))
 * - tag: a named lightweight pointer to a commit (can be pushed without conflicts)
 * - snapshot: a branch-like construct that can be merged with any other snapshot
 * - pr: a pull request (references source and target snapshots)
 */

class BruvObjects {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.objectsDir = path.join(repoPath, '.bruv', 'objects');
    this.refsDir = path.join(repoPath, '.bruv', 'refs');
  }

  // ---- Object storage ----

  objectPath(hash) {
    return path.join(this.objectsDir, hash.slice(0, 2), hash.slice(2));
  }

  writeObject(type, content) {
    const header = `${type}\0`;
    const buf = Buffer.concat([Buffer.from(header, 'utf8'), Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')]);
    const hash = hashBuffer(buf);
    const objPath = this.objectPath(hash);
    if (!fs.existsSync(objPath)) {
      ensureDir(path.dirname(objPath));
      fs.writeFileSync(objPath, buf);
    }
    return hash;
  }

  readObject(hash) {
    const objPath = this.objectPath(hash);
    if (!fs.existsSync(objPath)) return null;
    const buf = fs.readFileSync(objPath);
    const nullIdx = buf.indexOf(0);
    const type = buf.slice(0, nullIdx).toString('utf8');
    const content = buf.slice(nullIdx + 1);
    return { type, content };
  }

  objectExists(hash) {
    return fs.existsSync(this.objectPath(hash));
  }

  // ---- Blobs ----

  writeBlob(content) {
    return this.writeObject('blob', content);
  }

  readBlob(hash) {
    const obj = this.readObject(hash);
    if (!obj || obj.type !== 'blob') return null;
    return obj.content;
  }

  writeFileBlob(filePath) {
    const content = fs.readFileSync(filePath);
    return this.writeBlob(content);
  }

  // ---- Trees ----

  writeTree(entries) {
    // entries: [{ name, type: 'blob'|'tree', hash }]
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const lines = entries.map(e => `${e.type} ${e.hash} ${e.name}`).join('\n');
    return this.writeObject('tree', lines);
  }

  readTree(hash) {
    const obj = this.readObject(hash);
    if (!obj || obj.type !== 'tree') return null;
    const lines = obj.content.toString('utf8').trim().split('\n').filter(Boolean);
    return lines.map(line => {
      const [type, hash, ...nameParts] = line.split(' ');
      return { type, hash, name: nameParts.join(' ') };
    });
  }

  writeDirectoryTree(dirPath) {
    const entries = [];
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name === '.bruv' || item.name === '.git' || item.name === 'node_modules') continue;
      const fullPath = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        const treeHash = this.writeDirectoryTree(fullPath);
        entries.push({ name: item.name, type: 'tree', hash: treeHash });
      } else if (item.isFile()) {
        const blobHash = this.writeFileBlob(fullPath);
        entries.push({ name: item.name, type: 'blob', hash: blobHash });
      }
    }
    return this.writeTree(entries);
  }

  checkoutTree(treeHash, destDir) {
    const tree = this.readTree(treeHash);
    if (!tree) throw new Error(`Tree ${shortHash(treeHash)} not found`);
    for (const entry of tree) {
      const destPath = path.join(destDir, entry.name);
      if (entry.type === 'tree') {
        ensureDir(destPath);
        this.checkoutTree(entry.hash, destPath);
      } else {
        const content = this.readBlob(entry.hash);
        if (content) {
          ensureDir(path.dirname(destPath));
          fs.writeFileSync(destPath, content);
        }
      }
    }
  }

  // ---- Commits ----

  writeCommit({ tree, parents = [], message, author, timestamp = new Date().toISOString(), metadata = {} }) {
    const commitObj = JSON.stringify({ tree, parents, message, author, timestamp, metadata });
    return this.writeObject('commit', commitObj);
  }

  readCommit(hash) {
    const obj = this.readObject(hash);
    if (!obj || obj.type !== 'commit') return null;
    return JSON.parse(obj.content.toString('utf8'));
  }

  // ---- Tags (merge-safe pointers) ----

  writeTag({ name, commit, message = '', author, timestamp = new Date().toISOString(), metadata = {} }) {
    const tagObj = JSON.stringify({ name, commit, message, author, timestamp, metadata });
    const tagHash = this.writeObject('tag', tagObj);
    // Also store named ref
    const refPath = path.join(this.refsDir, 'tags', name);
    ensureDir(path.dirname(refPath));
    fs.writeFileSync(refPath, commit + '\n' + tagHash, 'utf8');
    return tagHash;
  }

  readTag(name) {
    const refPath = path.join(this.refsDir, 'tags', name);
    if (!fs.existsSync(refPath)) return null;
    const [commitHash, tagHash] = fs.readFileSync(refPath, 'utf8').trim().split('\n');
    const commit = this.readCommit(commitHash);
    const tagObj = this.readObject(tagHash);
    if (!commit || !tagObj) return null;
    const tag = JSON.parse(tagObj.content.toString('utf8'));
    return { ...tag, commitHash, commit };
  }

  listTags() {
    const tagsDir = path.join(this.refsDir, 'tags');
    if (!fs.existsSync(tagsDir)) return [];
    return fs.readdirSync(tagsDir).filter(f => !f.startsWith('.'));
  }

  // ---- Snapshots (branch-like, merge-safe) ----

  writeSnapshot({ name, commit, message = '', author, parent = null, timestamp = new Date().toISOString(), metadata = {} }) {
    const snapObj = JSON.stringify({ name, commit, message, author, parent, timestamp, metadata });
    const snapHash = this.writeObject('snapshot', snapObj);
    const refPath = path.join(this.refsDir, 'snapshots', name);
    ensureDir(path.dirname(refPath));
    // Store both commit and snapshot object hash
    fs.writeFileSync(refPath, commit + '\n' + snapHash, 'utf8');
    return snapHash;
  }

  readSnapshot(name) {
    const refPath = path.join(this.refsDir, 'snapshots', name);
    if (!fs.existsSync(refPath)) return null;
    const [commitHash, snapHash] = fs.readFileSync(refPath, 'utf8').trim().split('\n');
    const commit = this.readCommit(commitHash);
    const snapObj = this.readObject(snapHash);
    if (!commit || !snapObj) return null;
    const snap = JSON.parse(snapObj.content.toString('utf8'));
    return { ...snap, commitHash: commitHash, commit };
  }

  listSnapshots() {
    const snapDir = path.join(this.refsDir, 'snapshots');
    if (!fs.existsSync(snapDir)) return [];
    return fs.readdirSync(snapDir).filter(f => !f.startsWith('.'));
  }

  // ---- HEAD ----

  getHead() {
    const headPath = path.join(this.repoPath, '.bruv', 'HEAD');
    if (!fs.existsSync(headPath)) return null;
    const content = fs.readFileSync(headPath, 'utf8').trim();
    const [type, name] = content.split(': ');
    return { type, name, ref: content };
  }

  setHead(type, name) {
    const headPath = path.join(this.repoPath, '.bruv', 'HEAD');
    fs.writeFileSync(headPath, `${type}: ${name}`, 'utf8');
  }

  resolveHead() {
    const head = this.getHead();
    if (!head) return null;
    switch (head.type) {
      case 'snapshot': {
        const snap = this.readSnapshot(head.name);
        return snap ? { type: 'snapshot', ref: head.name, ...snap } : null;
      }
      case 'tag': {
        const tag = this.readTag(head.name);
        return tag ? { type: 'tag', ref: head.name, ...tag } : null;
      }
      case 'commit': {
        const commit = this.readCommit(head.name);
        return commit ? { type: 'commit', ref: head.name, commit } : null;
      }
      default:
        return null;
    }
  }

  // ---- PRs ----

  writePR({ title, description, sourceSnapshot, targetSnapshot, author, isPrivate = false, reviewers = [], timestamp = new Date().toISOString(), status = 'open' }) {
    const prObj = JSON.stringify({ title, description, sourceSnapshot, targetSnapshot, author, isPrivate, reviewers, timestamp, status, comments: [] });
    const prHash = this.writeObject('pr', prObj);
    const refPath = path.join(this.refsDir, 'prs', prHash.slice(0, 7));
    ensureDir(path.dirname(refPath));
    fs.writeFileSync(refPath, prHash, 'utf8');
    return prHash;
  }

  readPR(hashOrId) {
    // Allow lookup by full hash or short ID
    if (hashOrId.length < 64) {
      const prsDir = path.join(this.refsDir, 'prs');
      if (!fs.existsSync(prsDir)) return null;
      for (const file of fs.readdirSync(prsDir)) {
        if (file.startsWith(hashOrId)) {
          hashOrId = fs.readFileSync(path.join(prsDir, file), 'utf8').trim();
          break;
        }
      }
    }
    const obj = this.readObject(hashOrId);
    if (!obj || obj.type !== 'pr') return null;
    const pr = JSON.parse(obj.content.toString('utf8'));
    return { ...pr, id: hashOrId.slice(0, 7), fullHash: hashOrId };
  }

  listPRs(status = null) {
    const prsDir = path.join(this.refsDir, 'prs');
    if (!fs.existsSync(prsDir)) return [];
    const prs = [];
    for (const file of fs.readdirSync(prsDir)) {
      const hash = fs.readFileSync(path.join(prsDir, file), 'utf8').trim();
      const pr = this.readPR(hash);
      if (pr && (!status || pr.status === status)) {
        prs.push(pr);
      }
    }
    return prs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  updatePR(hash, updates) {
    const pr = this.readPR(hash);
    if (!pr) throw new Error(`PR ${hash} not found`);
    Object.assign(pr, updates);
    delete pr.id;
    delete pr.fullHash;
    return this.writePR(pr);
  }

  // ---- History traversal ----

  getCommitHistory(startCommitHash, maxCount = 100) {
    const history = [];
    const visited = new Set();
    const queue = [startCommitHash];
    
    while (queue.length > 0 && history.length < maxCount) {
      const hash = queue.shift();
      if (visited.has(hash)) continue;
      visited.add(hash);
      
      const commit = this.readCommit(hash);
      if (!commit) continue;
      history.push({ hash, ...commit });
      
      for (const parentHash of commit.parents || []) {
        if (!visited.has(parentHash)) {
          queue.push(parentHash);
        }
      }
    }
    
    return history;
  }
}

module.exports = BruvObjects;
