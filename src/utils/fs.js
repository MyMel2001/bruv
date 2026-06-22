const fs = require('fs');
const path = require('path');

/**
 * Filesystem utilities for bruv.
 */

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function rimraf(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      rimraf(full);
    } else {
      fs.unlinkSync(full);
    }
  }
  fs.rmdirSync(dirPath);
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function readJson(filePath, defaultValue = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function listDirRecursive(dirPath, ignorePatterns = []) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    const relative = path.relative(dirPath, full);
    
    if (ignorePatterns.some(p => relative.startsWith(p) || relative === p)) continue;
    
    if (entry.isDirectory()) {
      results.push(...listDirRecursive(full, ignorePatterns).map(f => path.join(relative, f)));
    } else {
      results.push(relative);
    }
  }
  return results;
}

module.exports = { ensureDir, rimraf, copyFile, readJson, writeJson, listDirRecursive };
