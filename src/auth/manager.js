const fs = require('fs');
const path = require('path');
const { loadConfig, saveAuth, loadAuth, clearAuth, BRUV_CONFIG_DIR } = require('../config');

/**
 * Authentication system for bruv.
 * Uses username/password with the bruv API server.
 * Required for private features (private repos, private PRs, sharing).
 */

class AuthManager {
  constructor() {
    this.config = loadConfig();
  }

  async login(username, password) {
    const apiUrl = this.config.BRUV_API_URL;

    try {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `Authentication failed (${response.status})`);
      }

      const data = await response.json();
      saveAuth(data.token, { username, ...data.user });
      return { success: true, token: data.token, user: data.user };
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
        throw new Error(`Cannot connect to bruv API at ${apiUrl}. Check BRUV_API_URL in your config.`);
      }
      throw e;
    }
  }

  async register(username, password, email) {
    const apiUrl = this.config.BRUV_API_URL;

    try {
      const response = await fetch(`${apiUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, email }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `Registration failed (${response.status})`);
      }

      const data = await response.json();
      saveAuth(data.token, { username, ...data.user });
      return { success: true, token: data.token, user: data.user };
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
        throw new Error(`Cannot connect to bruv API at ${apiUrl}. Check BRUV_API_URL in your config.`);
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
    // Check if token is still valid (basic check)
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

    const apiUrl = this.config.BRUV_API_URL;
    try {
      const response = await fetch(`${apiUrl}/auth/validate`, {
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
}

module.exports = AuthManager;
