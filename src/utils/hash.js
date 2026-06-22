const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Content-addressable hashing utilities for bruv.
 * Uses SHA-256 for blob hashing to uniquely identify content.
 */

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashString(str) {
  return hashBuffer(Buffer.from(str, 'utf8'));
}

function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return hashBuffer(buf);
}

function hashObject(obj) {
  return hashString(JSON.stringify(obj, Object.keys(obj).sort()));
}

/** Short hash for display purposes (first 7 chars) */
function shortHash(fullHash) {
  return fullHash.slice(0, 7);
}

module.exports = { hashBuffer, hashString, hashFile, hashObject, shortHash };
