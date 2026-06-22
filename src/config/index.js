const fs = require('fs');
const path = require('path');
const os = require('os');

const BRUV_CONFIG_DIR = path.join(os.homedir(), '.config', 'bruv');
const BRUV_CONFIG_FILE = path.join(BRUV_CONFIG_DIR, 'bruv.env');
const BRUV_AUTH_FILE = path.join(BRUV_CONFIG_DIR, 'auth.json');

/**
 * Configuration system for bruv.
 * Reads from ~/.config/bruv/bruv.env (dotenv format).
 */

const DEFAULTS = {
  // User identity
  BRUV_USER_NAME: '',
  BRUV_USER_EMAIL: '',

  // API server for auth & sharing
  BRUV_API_URL: 'https://api.bruv.sh',
  BRUV_API_PORT: 2658,

  // AI integration for safe file detection
  BRUV_AI_ENDPOINT: '',
  BRUV_AI_API_KEY: '',
  BRUV_AI_MODEL: 'gpt-4o',

  // Security
  BRUV_DANGER_FLAG_DEFAULT: false,
  BRUV_BLOCK_ENV_FILES: true,
  BRUV_BLOCKED_PATTERNS: '.env,.env.*,*.pem,*.key,id_rsa,id_ed25519,credentials.json,service-account.json,secrets.yml,secrets.yaml,.npmrc,.pypirc,.netrc',

  // Merge behavior
  BRUV_MERGE_STRATEGY: 'union', // union | manual | ai
  BRUV_CONFLICT_STRATEGY: 'ask', // ask | custom | automated

  // Private features
  BRUV_DEFAULT_PRIVATE: false,
};

function loadConfig() {
  const config = { ...DEFAULTS };

  if (fs.existsSync(BRUV_CONFIG_FILE)) {
    const content = fs.readFileSync(BRUV_CONFIG_FILE, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key in DEFAULTS) {
        // Parse booleans
        if (value === 'true') config[key] = true;
        else if (value === 'false') config[key] = false;
        else if (key === 'BRUV_API_PORT') config[key] = parseInt(value, 10);
        else config[key] = value;
      }
    }
  }

  return config;
}

function saveAuth(token, user) {
  if (!fs.existsSync(BRUV_CONFIG_DIR)) {
    fs.mkdirSync(BRUV_CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(BRUV_AUTH_FILE, JSON.stringify({ token, user, authedAt: new Date().toISOString() }, null, 2), 'utf8');
}

function loadAuth() {
  if (!fs.existsSync(BRUV_AUTH_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(BRUV_AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function clearAuth() {
  if (fs.existsSync(BRUV_AUTH_FILE)) {
    fs.unlinkSync(BRUV_AUTH_FILE);
  }
}

function getBlockedPatterns(config) {
  return config.BRUV_BLOCKED_PATTERNS.split(',').map(p => p.trim()).filter(Boolean);
}

module.exports = { BRUV_CONFIG_DIR, BRUV_CONFIG_FILE, BRUV_AUTH_FILE, DEFAULTS, loadConfig, saveAuth, loadAuth, clearAuth, getBlockedPatterns };
