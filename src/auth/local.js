const fs = require('fs');
const crypto = require('crypto');
const { BRUV_CONFIG_DIR } = require('../config');

const USERS_DB_FILE = pathModule => pathModule.join(BRUV_CONFIG_DIR, 'users.json');

/**
 * Local user database for the bruv API server.
 * Stores registered users in ~/.config/bruv/users.json.
 * Passwords are hashed with salted SHA-256.
 */

function getDbPath() {
  const path = require('path');
  return path.join(BRUV_CONFIG_DIR, 'users.json');
}

function loadUsers() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  if (!fs.existsSync(BRUV_CONFIG_DIR)) {
    fs.mkdirSync(BRUV_CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(getDbPath(), JSON.stringify(users, null, 2), 'utf8');
}

/**
 * Hash a password with a random salt using SHA-256.
 * Returns `salt:hash` format.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored `salt:hash` string.
 */
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const computed = crypto.createHash('sha256').update(salt + password).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
}

module.exports = { loadUsers, saveUsers, hashPassword, verifyPassword };
