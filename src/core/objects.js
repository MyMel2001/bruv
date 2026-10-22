const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { hashBuffer, hashString, hashObject, shortHash } = require('../utils/hash');
const { ensureDir } = require('../utils/fs');

// Hash over the uncompressed "<type>\0<content>" payload — same as writeObject.
function hashPayload(type, content) {
  return hashBuffer(Buffer.concat([Buffer.from(`${type}\0`, 'utf8'), Buffer.isBuffer(content) ? content : Buffer.from(content)]));
}

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
    const raw = Buffer.concat([Buffer.from(header, 'utf8'), Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')]);
    // Hash stays over the uncompressed payload so it matches legacy repos.
    const hash = hashBuffer(raw);
    const objPath = this.objectPath(hash);
    if (!fs.existsSync(objPath)) {
      ensureDir(path.dirname(objPath));
      fs.writeFileSync(objPath, zlib.deflateSync(raw));
    }
    return hash;
  }

  readObject(hash) {
    const objPath = this.objectPath(hash);
    if (!fs.existsSync(objPath)) return null;
    let buf = fs.readFileSync(objPath);
    // Legacy objects are stored raw; new ones are deflate-compressed.
    try { buf = zlib.inflateSync(buf); } catch { /* raw legacy object */ }
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
        return commit ? { type: 'commit', ref: head.name, commit, commitHash: head.name, treeHash: commit.tree } : null;
      }
      default:
        return null;
    }
  }

  // ---- PRs ----

  writePR(pr) {
    // Stable id: reused on update so PR links don't break and refs don't pile up.
    const prId = pr.id || hashString(JSON.stringify(pr)).slice(0, 7);
    const prObj = JSON.stringify({ comments: [], reviewers: [], status: 'open', ...pr, id: prId });
    const prHash = this.writeObject('pr', prObj);
    const refPath = path.join(this.refsDir, 'prs', prId);
    ensureDir(path.dirname(refPath));
    fs.writeFileSync(refPath, prHash, 'utf8');
    return prHash;
  }

  readPR(hashOrId) {
    // Allow lookup by full hash or short ID (ref name)
    if (hashOrId.length < 64) {
      const prsDir = path.join(this.refsDir, 'prs');
      if (!fs.existsSync(prsDir)) return null;
      for (const file of fs.readdirSync(prsDir)) {
        if (file === hashOrId || file.startsWith(hashOrId)) {
          hashOrId = fs.readFileSync(path.join(prsDir, file), 'utf8').trim();
          break;
        }
      }
    }
    const obj = this.readObject(hashOrId);
    if (!obj || obj.type !== 'pr') return null;
    const pr = JSON.parse(obj.content.toString('utf8'));
    return { ...pr, id: pr.id || hashOrId.slice(0, 7), fullHash: hashOrId };
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
    const { id, fullHash, ...fields } = pr;
    const merged = { ...fields, ...updates, id, timestamp: pr.timestamp };
    // Repoint the existing ref instead of adding a new one (no stale refs).
    return this.writePR(merged);
  }

  // ---- Object transfer (push / pull / clone) ----

  // Collect every object reachable from the given commit hashes (commits + trees + blobs).
  collectReachable(startCommitHashes) {
    const seen = new Set();
    const queue = [...startCommitHashes];
    while (queue.length > 0) {
      const hash = queue.shift();
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      const obj = this.readObject(hash);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const commit = JSON.parse(obj.content.toString('utf8'));
        queue.push(commit.tree, ...(commit.parents || []));
      } else if (obj.type === 'tree') {
        for (const line of obj.content.toString('utf8').trim().split('\n').filter(Boolean)) {
          const [type, entryHash] = line.split(' ');
          queue.push(entryHash);
        }
      }
    }
    return seen;
  }

  // Export objects reachable from the given commits as JSON-safe payloads.
  exportCommits(commitHashes) {
    const hashes = this.collectReachable(commitHashes);
    const objects = [];
    for (const hash of hashes) {
      const obj = this.readObject(hash);
      if (obj) objects.push({ hash, type: obj.type, content: obj.content.toString('base64') });
    }
    return objects;
  }

  // Import objects, verifying each hash before writing. Returns imported count.
  importObjects(objects = []) {
    let imported = 0;
    for (const { hash, type, content } of objects) {
      const buf = Buffer.from(content, 'base64');
      if (hashPayload(type, buf) !== hash) {
        throw new Error(`Object ${hash} failed hash verification`);
      }
      if (!this.objectExists(hash)) {
        this.writeObject(type, buf);
        imported++;
      }
    }
    return imported;
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
