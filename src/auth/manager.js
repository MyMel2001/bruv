const fs = require('fs');
const path = require('path');
const { loadConfig, saveAuth, loadAuth, clearAuth, BRUV_CONFIG_DIR, hasAutoRegisterCredentials } = require('../config');

/**
 * Authentication system for bruv.
 * Acts as a client to the bruv API server for CLI auth operations.
 * Required for private features (private repos, private PRs, sharing).
 * 
 * Auto-register: If the user attempts a private action without being authed,
 * and BRUV_USER_NAME + BRUV_USER_PASSWORD are set in config,
 * the system will automatically attempt to register (or login) before proceeding.
 */

class AuthManager {
  constructor() {
    this.config = loadConfig();
  }

  /**
   * Build the API base URL. Ensures /api is always present.
   * If BRUV_API_URL already ends with /api, don't double it up.
   */
  _getApiBaseUrl() {
    let apiUrl = this.config.BRUV_API_URL.replace(/\/+$/, ''); // strip trailing slashes
    if (!apiUrl.endsWith('/api')) {
      apiUrl += '/api';
    }
    return apiUrl;
  }

  async login(username, password) {
    const apiBase = this._getApiBaseUrl();

    try {
      const response = await fetch(`${apiBase}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || err.message || `Authentication failed (${response.status})`);
      }

      const data = await response.json();
      saveAuth(data.token, { username, ...data.user });
      return { success: true, token: data.token, user: data.user };
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
        throw new Error(`Cannot connect to bruv API at ${apiBase}. Check BRUV_API_URL in your config.`);
      }
      throw e;
    }
  }

  async register(username, password, email) {
    const apiBase = this._getApiBaseUrl();

    try {
      const response = await fetch(`${apiBase}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, email }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || err.message || `Registration failed (${response.status})`);
      }

      const data = await response.json();
      saveAuth(data.token, { username, ...data.user });
      return { success: true, token: data.token, user: data.user };
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
        throw new Error(`Cannot connect to bruv API at ${apiBase}. Check BRUV_API_URL in your config.`);
      }
      throw e;
    }
  }

  logout() {
    clearAuth();
    return { success: true };
  }

  isAuthenticated() {
    const auth = loadAuth();
    if (!auth) return false;
    return !!auth.token;
  }

  getCurrentUser() {
    const auth = loadAuth();
    if (!auth) return null;
    return auth.user;
  }

  getToken() {
    const auth = loadAuth();
    return auth?.token || null;
  }

  async validateToken() {
    const auth = loadAuth();
    if (!auth) return false;

    const apiBase = this._getApiBaseUrl();
    try {
      const response = await fetch(`${apiBase}/auth/validate`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check if the current user has access to a shared resource.
   */
  canAccess(sharedWith) {
    const user = this.getCurrentUser();
    if (!user) return false;
    return sharedWith.includes(user.username);
  }

  /**
   * Ensure the user is authenticated before a private action.
   * If not authenticated, attempts auto-register using config credentials
   * (BRUV_USER_NAME + BRUV_USER_PASSWORD). If register fails (user may
   * already exist), falls back to login.
   * 
   * Returns true if authenticated (or successfully auto-registered), false otherwise.
   */
  async ensureAuthenticated() {
    if (this.isAuthenticated()) return true;

    // Check if auto-register is enabled and credentials are available
    if (!this.config.BRUV_AUTO_REGISTER) {
      return false;
    }

    if (!hasAutoRegisterCredentials(this.config)) {
      return false;
    }

    const username = this.config.BRUV_USER_NAME;
    const password = this.config.BRUV_USER_PASSWORD;
    const email = this.config.BRUV_USER_EMAIL || '';

    // Try register first (user may not exist yet)
    try {
      const result = await this.register(username, password, email);
      if (result.success) {
        console.log(`\x1b[32m✔ Auto-registered as ${username}\x1b[0m`);
        return true;
      }
    } catch (e) {
      // Register failed - user may already exist, try login
    }

    // Fall back to login
    try {
      const result = await this.login(username, password);
      if (result.success) {
        console.log(`\x1b[32m✔ Auto-logged in as ${username}\x1b[0m`);
        return true;
      }
    } catch (e) {
      // Login also failed
    }

    return false;
  }

  /**
   * Require authentication for a private action.
   * Auto-registers if possible, otherwise throws an error with instructions.
   */
  async requireAuth() {
    const authed = await this.ensureAuthenticated();
    if (authed) return true;

    throw new Error(
      'Not authenticated. Either:\n' +
      '  1. Run `bruv auth login -u <user> -p <pass>` to authenticate\n' +
      '  2. Set BRUV_USER_NAME and BRUV_USER_PASSWORD in ~/.config/bruv/bruv.env for auto-register\n' +
      '  3. Run `bruv auth register -u <user> -p <pass>` to create an account'
    );
  }
}

module.exports = AuthManager;
