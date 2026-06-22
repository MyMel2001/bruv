/**
 * bruv - Source control that's easier than git
 * 
 * Main entry point. Provides programmatic access to all bruv features.
 */

const BruvRepo = require('./core/repo');
const BruvObjects = require('./core/objects');
const SnapshotManager = require('./snapshot/manager');
const PRManager = require('./pr/manager');
const MergeEngine = require('./merge/engine');
const AuthManager = require('./auth/manager');
const BruvServer = require('./api/server');
const { loadConfig, saveAuth, loadAuth, clearAuth, getBlockedPatterns, BRUV_CONFIG_FILE, BRUV_CONFIG_DIR } = require('./config');
const { scanFiles, aiScanFiles } = require('./security/scanner');
const { shortHash } = require('./utils/hash');
const { ensureDir, readJson, writeJson } = require('./utils/fs');

module.exports = {
  BruvRepo,
  BruvObjects,
  SnapshotManager,
  PRManager,
  MergeEngine,
  AuthManager,
  BruvServer,
  loadConfig,
  saveAuth,
  loadAuth,
  clearAuth,
  getBlockedPatterns,
  scanFiles,
  aiScanFiles,
  shortHash,
  ensureDir,
  readJson,
  writeJson,
  BRUV_CONFIG_FILE,
  BRUV_CONFIG_DIR,
};
