const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

/**
 * Express.js API server for bruv.
 * Exposes VCS operations on port 2658 for GitHub-like app integration.
 */

class BruvServer {
  constructor(repoPath, port = 2658) {
    this.repoPath = repoPath;
    this.port = port;
    this.app = express();
    this.server = null;

    this._setupMiddleware();
    this._setupRoutes();
  }

  _setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Auth middleware for protected endpoints
    this.app.use('/api', (req, res, next) => {
      // Public endpoints
      const publicPaths = ['/api/health', '/api/auth/login', '/api/auth/register'];
      if (publicPaths.includes(req.path)) return next();

      // Check for auth header
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        // Allow unauthenticated access to public repos
        req.authed = false;
        req.username = null;
      } else {
        req.authed = true;
        req.token = authHeader.slice(7);
        // In production, validate token with bruv API
        req.username = req.headers['x-bruv-user'] || null;
      }
      next();
    });
  }

  _setupRoutes() {
    const BruvRepo = require('../core/repo');
    const SnapshotManager = require('../snapshot/manager');
    const PRManager = require('../pr/manager');
    const AuthManager = require('../auth/manager');
    const { loadConfig } = require('../config');

    // ---- Health ----
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', version: '0.1.0', name: 'bruv' });
    });

    // ---- Auth ----
    this.app.post('/api/auth/login', async (req, res) => {
      try {
        const { username, password } = req.body;
        const auth = new AuthManager();
        const result = await auth.login(username, password);
        res.json(result);
      } catch (e) {
        res.status(401).json({ error: e.message });
      }
    });

    this.app.post('/api/auth/register', async (req, res) => {
      try {
        const { username, password, email } = req.body;
        const auth = new AuthManager();
        const result = await auth.register(username, password, email);
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.get('/api/auth/me', (req, res) => {
      const auth = new AuthManager();
      const user = auth.getCurrentUser();
      if (user) {
        res.json({ user });
      } else {
        res.status(401).json({ error: 'Not authenticated' });
      }
    });

    // ---- Repository ----
    this.app.get('/api/repo/info', (req, res) => {
      try {
        const repo = new BruvRepo(this.repoPath);
        res.json({
          name: path.basename(this.repoPath),
          config: repo.getConfig(),
          head: repo.objects.getHead(),
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/repo/init', (req, res) => {
      try {
        const { private: isPrivate, remote, author, email } = req.body;
        const repo = BruvRepo.init(this.repoPath, { private: isPrivate, remote, author, email });
        res.json({ success: true, message: 'Repository initialized' });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- Files & Staging ----
    this.app.get('/api/repo/status', (req, res) => {
      try {
        const repo = new BruvRepo(this.repoPath);
        const status = repo.status();
        res.json(status);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/repo/add', (req, res) => {
      try {
        const { files, danger } = req.body;
        const repo = new BruvRepo(this.repoPath);
        const count = repo.add(files, { danger });
        res.json({ success: true, filesAdded: count });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/repo/commit', (req, res) => {
      try {
        const { message, author } = req.body;
        const repo = new BruvRepo(this.repoPath);
        const result = repo.commit(message, { author });
        res.json({ success: true, ...result });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- Commits ----
    this.app.get('/api/repo/log', (req, res) => {
      try {
        const repo = new BruvRepo(this.repoPath);
        const count = parseInt(req.query.count) || 50;
        const log = repo.log(count);
        res.json(log);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/repo/diff', (req, res) => {
      try {
        const repo = new BruvRepo(this.repoPath);
        const diffs = repo.diff();
        res.json(diffs);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ---- Snapshots ----
    this.app.get('/api/snapshots', (req, res) => {
      try {
        const sm = new SnapshotManager(this.repoPath);
        const snapshots = sm.list().map(name => {
          const snap = sm.get(name);
          return { name, ...snap };
        });
        res.json(snapshots);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/snapshots', (req, res) => {
      try {
        const { name, message, author } = req.body;
        const repo = new BruvRepo(this.repoPath);
        const result = repo.snapshot(name, { message, author });
        res.json({ success: true, ...result });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/snapshots/switch', (req, res) => {
      try {
        const { name } = req.body;
        const repo = new BruvRepo(this.repoPath);
        const result = repo.switchSnapshot(name);
        res.json({ success: true, snapshot: result });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.delete('/api/snapshots/:name', (req, res) => {
      try {
        const sm = new SnapshotManager(this.repoPath);
        const deleted = sm.delete(req.params.name);
        res.json({ success: deleted });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- Snapshot merging (no conflicts by design) ----
    this.app.post('/api/snapshots/merge', async (req, res) => {
      try {
        const { sources, strategy, message, author } = req.body;
        const repo = new BruvRepo(this.repoPath);
        
        if (strategy === 'custom') {
          const result = await repo.merge(sources[0], sources[1], { strategy: 'custom' });
          res.json(result);
        } else if (strategy === 'automated') {
          const result = await repo.merge(sources[0], sources[1], { strategy: 'automated', message, author });
          res.json(result);
        } else {
          const sm = new SnapshotManager(this.repoPath);
          const mergedCommitHash = sm.mergeSnapshots(sources, author || 'api', message);
          res.json({ success: true, mergeCommitHash: mergedCommitHash });
        }
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- Snapshot sharing (private features) ----
    this.app.post('/api/snapshots/:name/share', (req, res) => {
      try {
        if (!req.authed) return res.status(401).json({ error: 'Authentication required' });
        const { username } = req.body;
        const sm = new SnapshotManager(this.repoPath);
        sm.shareWithUser(req.params.name, username);
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/snapshots/:name/unshare', (req, res) => {
      try {
        if (!req.authed) return res.status(401).json({ error: 'Authentication required' });
        const { username } = req.body;
        const sm = new SnapshotManager(this.repoPath);
        sm.revokeAccess(req.params.name, username);
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- Tags ----
    this.app.get('/api/tags', (req, res) => {
      try {
        const repo = new BruvRepo(this.repoPath);
        const tags = repo.objects.listTags().map(name => {
          const tag = repo.objects.readTag(name);
          return { name, ...tag };
        });
        res.json(tags);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/tags', (req, res) => {
      try {
        const { name, message, author } = req.body;
        const repo = new BruvRepo(this.repoPath);
        const result = repo.tag(name, { message, author });
        res.json({ success: true, ...result });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- Pull Requests ----
    this.app.get('/api/prs', (req, res) => {
      try {
        const prm = new PRManager(this.repoPath);
        const status = req.query.status || null;
        const prs = prm.list(status);
        res.json(prs);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/prs', (req, res) => {
      try {
        const { title, description, sourceSnapshot, targetSnapshot, author, isPrivate, reviewers } = req.body;
        const prm = new PRManager(this.repoPath);
        const prHash = prm.create({ title, description, sourceSnapshot, targetSnapshot, author, isPrivate, reviewers });
        res.json({ success: true, id: prHash.slice(0, 7), fullHash: prHash });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.get('/api/prs/:id', (req, res) => {
      try {
        const prm = new PRManager(this.repoPath);
        const pr = prm.get(req.params.id);
        if (!pr) return res.status(404).json({ error: 'PR not found' });
        res.json(pr);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/prs/:id/close', (req, res) => {
      try {
        const prm = new PRManager(this.repoPath);
        prm.close(req.params.id, req.body.closedBy || 'api');
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/prs/:id/reopen', (req, res) => {
      try {
        const prm = new PRManager(this.repoPath);
        prm.reopen(req.params.id);
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/prs/:id/merge', async (req, res) => {
      try {
        const { strategy, choices, author } = req.body;
        const prm = new PRManager(this.repoPath);
        const result = await prm.merge(req.params.id, author || 'api', strategy || 'union', choices);
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/prs/:id/comment', (req, res) => {
      try {
        const { author, body } = req.body;
        const prm = new PRManager(this.repoPath);
        prm.addComment(req.params.id, author || 'api', body);
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/prs/:id/approve', (req, res) => {
      try {
        const { approver } = req.body;
        const prm = new PRManager(this.repoPath);
        prm.approve(req.params.id, approver || 'api');
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- PR sharing (private features) ----
    this.app.post('/api/prs/:id/share', (req, res) => {
      try {
        if (!req.authed) return res.status(401).json({ error: 'Authentication required' });
        const { username } = req.body;
        const prm = new PRManager(this.repoPath);
        prm.shareWithUser(req.params.id, username);
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/prs/:id/unshare', (req, res) => {
      try {
        if (!req.authed) return res.status(401).json({ error: 'Authentication required' });
        const { username } = req.body;
        const prm = new PRManager(this.repoPath);
        prm.revokeAccess(req.params.id, username);
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- Remote operations ----
    this.app.post('/api/repo/push', async (req, res) => {
      try {
        const repo = new BruvRepo(this.repoPath);
        const result = await repo.push(req.body);
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/repo/pull', async (req, res) => {
      try {
        const repo = new BruvRepo(this.repoPath);
        const result = await repo.pull(req.body);
        res.json(result);
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- Remotes ----
    this.app.get('/api/remotes', (req, res) => {
      try {
        const repo = new BruvRepo(this.repoPath);
        res.json(repo.listRemotes());
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/remotes', (req, res) => {
      try {
        const { name, url } = req.body;
        const repo = new BruvRepo(this.repoPath);
        repo.addRemote(name, url);
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.delete('/api/remotes/:name', (req, res) => {
      try {
        const repo = new BruvRepo(this.repoPath);
        repo.removeRemote(req.params.name);
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- Config ----
    this.app.get('/api/config', (req, res) => {
      res.json(loadConfig());
    });

    this.app.post('/api/config', (req, res) => {
      try {
        const repo = new BruvRepo(this.repoPath);
        const { key, value } = req.body;
        repo.setConfig(key, value);
        res.json({ success: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // ---- Security scan ----
    this.app.post('/api/security/scan', async (req, res) => {
      try {
        const { files, useAI } = req.body;
        const { scanFiles, aiScanFiles } = require('../security/scanner');
        if (useAI) {
          const result = await aiScanFiles(files, this.repoPath);
          res.json(result);
        } else {
          const result = scanFiles(files, this.repoPath);
          res.json(result);
        }
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ---- Error handler ----
    this.app.use((err, req, res, _next) => {
      console.error('API Error:', err.message);
      res.status(500).json({ error: err.message || 'Internal server error' });
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`🟢 bruv API server running on http://localhost:${this.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = BruvServer;
