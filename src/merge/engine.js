const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config');

/**
 * Merge engine for bruv.
 * 
 * Key design principles:
 * - Snapshots can be merged WITHOUT conflicts by default (union merge)
 * - If conflicts are detected (same file, different content), the user chooses:
 *   1. "custom merge" - interactive per-file/per-change selection
 *   2. "automated merge" - LLM decides which changes to keep
 * - No complex conflict files to edit manually
 */

class MergeEngine {
  constructor(repoPath) {
    this.repoPath = repoPath;
    const BruvObjects = require('../core/objects');
    this.objects = new BruvObjects(repoPath);
  }

  /**
   * Detect if any files conflict between two trees.
   * Returns array of conflicting file paths with both versions.
   */
  detectConflicts(treeHashA, treeHashB) {
    const filesA = this._flattenTree(treeHashA);
    const filesB = this._flattenTree(treeHashB);

    const conflicts = [];
    const onlyA = new Map();
    const onlyB = new Map();

    for (const [filePath, info] of filesA) {
      if (filesB.has(filePath)) {
        if (info.hash !== filesB.get(filePath).hash) {
          conflicts.push({
            file: filePath,
            hashA: info.hash,
            hashB: filesB.get(filePath).hash,
            contentA: this.objects.readBlob(info.hash)?.toString('utf8') || '',
            contentB: this.objects.readBlob(filesB.get(filePath).hash)?.toString('utf8') || '',
          });
        }
      } else {
        onlyA.set(filePath, info);
      }
    }

    for (const [filePath, info] of filesB) {
      if (!filesA.has(filePath)) {
        onlyB.set(filePath, info);
      }
    }

    return { conflicts, onlyA: Object.fromEntries(onlyA), onlyB: Object.fromEntries(onlyB), allA: Object.fromEntries(filesA), allB: Object.fromEntries(filesB) };
  }

  /**
   * Perform a union merge - files from both trees coexist.
   * For conflicting files, last snapshot wins.
   */
  unionMerge(treeHashA, treeHashB, preferB = true) {
    const filesA = this._flattenTree(treeHashA);
    const filesB = this._flattenTree(treeHashB);

    const merged = new Map();

    // Add all files from A
    for (const [filePath, info] of filesA) {
      merged.set(filePath, info);
    }

    // Add/override with files from B
    for (const [filePath, info] of filesB) {
      if (merged.has(filePath) && merged.get(filePath).hash !== info.hash) {
        // Conflict: preference decides
        if (preferB) {
          merged.set(filePath, info);
        }
        // If preferA, keep existing
      } else {
        merged.set(filePath, info);
      }
    }

    return this._buildTreeFromMap(merged);
  }

  /**
   * Custom merge: user picks which version of each conflicting file to keep.
   * Returns a callback-based approach for interactive selection.
   */
  prepareCustomMerge(treeHashA, treeHashB) {
    const analysis = this.detectConflicts(treeHashA, treeHashB);
    return {
      conflicts: analysis.conflicts,
      nonConflictingA: analysis.onlyA,
      nonConflictingB: analysis.onlyB,
      resolve: (choices) => {
        // choices: { [filePath]: 'a' | 'b' }
        return this._resolveMerge(analysis, choices);
      }
    };
  }

  /**
   * Automated merge: LLM decides which version of each file to keep.
   */
  async automatedMerge(treeHashA, treeHashB, signal) {
    const analysis = this.detectConflicts(treeHashA, treeHashB);

    if (analysis.conflicts.length === 0) {
      return this.unionMerge(treeHashA, treeHashB);
    }

    const config = loadConfig();
    if (!config.BRUV_AI_ENDPOINT || !config.BRUV_AI_API_KEY) {
      throw new Error('AI endpoint not configured. Set BRUV_AI_ENDPOINT and BRUV_AI_API_KEY in ~/.config/bruv/bruv.env');
    }

    // Prepare conflict descriptions for AI
    const conflictDescriptions = analysis.conflicts.map(c => ({
      file: c.file,
      contentA: c.contentA.slice(0, 2000),
      contentB: c.contentB.slice(0, 2000),
    }));

    try {
      const response = await fetch(config.BRUV_AI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.BRUV_AI_API_KEY}`,
        },
        body: JSON.stringify({
          model: config.BRUV_AI_MODEL,
          messages: [{
            role: 'system',
            content: 'You are a merge resolution assistant. For each conflicting file, decide which version to keep (A or B), or provide a merged version. Respond with JSON: {"resolutions": [{"file": "path", "choice": "a"|"b"|"merged", "mergedContent": "... (only if choice is merged)"}]}'
          }, {
            role: 'user',
            content: JSON.stringify(conflictDescriptions)
          }],
          temperature: 0,
          max_tokens: 4096,
        }),
        signal,
      });

      if (!response.ok) {
        throw new Error(`AI API returned ${response.status}`);
      }

      const data = await response.json();
      const aiResult = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      const resolutions = aiResult.resolutions || [];

      // Convert AI choices to our format
      const choices = {};
      const mergedContents = {};
      for (const r of resolutions) {
        if (r.choice === 'merged' && r.mergedContent) {
          choices[r.file] = 'merged';
          mergedContents[r.file] = r.mergedContent;
        } else {
          choices[r.file] = r.choice === 'b' ? 'b' : 'a';
        }
      }

      return this._resolveMergeWithContent(analysis, choices, mergedContents);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(`AI merge failed: ${e.message}. Try custom merge instead.`);
    }
  }

  _resolveMerge(analysis, choices) {
    const merged = new Map();

    // Start with non-conflicting files from both
    for (const [filePath, info] of Object.entries(analysis.onlyA)) {
      merged.set(filePath, info);
    }
    for (const [filePath, info] of Object.entries(analysis.onlyB)) {
      merged.set(filePath, info);
    }

    // Also include non-conflicting shared files
    for (const [filePath, info] of Object.entries(analysis.allA)) {
      if (!analysis.conflicts.find(c => c.file === filePath)) {
        merged.set(filePath, info);
      }
    }

    // Resolve conflicts based on user choices
    for (const conflict of analysis.conflicts) {
      const choice = choices[conflict.file] || 'a';
      if (choice === 'a') {
        merged.set(conflict.file, { hash: conflict.hashA });
      } else {
        merged.set(conflict.file, { hash: conflict.hashB });
      }
    }

    return this._buildTreeFromMap(merged);
  }

  _resolveMergeWithContent(analysis, choices, mergedContents) {
    const merged = new Map();

    for (const [filePath, info] of Object.entries(analysis.onlyA)) {
      merged.set(filePath, info);
    }
    for (const [filePath, info] of Object.entries(analysis.onlyB)) {
      merged.set(filePath, info);
    }

    for (const [filePath, info] of Object.entries(analysis.allA)) {
      if (!analysis.conflicts.find(c => c.file === filePath)) {
        merged.set(filePath, info);
      }
    }

    for (const conflict of analysis.conflicts) {
      const choice = choices[conflict.file] || 'a';
      if (choice === 'merged' && mergedContents[conflict.file]) {
        const blobHash = this.objects.writeBlob(mergedContents[conflict.file]);
        merged.set(conflict.file, { hash: blobHash });
      } else if (choice === 'b') {
        merged.set(conflict.file, { hash: conflict.hashB });
      } else {
        merged.set(conflict.file, { hash: conflict.hashA });
      }
    }

    return this._buildTreeFromMap(merged);
  }

  _flattenTree(treeHash, prefix = '') {
    const result = new Map();
    const entries = this.objects.readTree(treeHash);
    if (!entries) return result;

    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'tree') {
        const subMap = this._flattenTree(entry.hash, fullPath);
        for (const [path, info] of subMap) {
          result.set(path, info);
        }
      } else {
        result.set(fullPath, { hash: entry.hash });
      }
    }
    return result;
  }

  _buildTreeFromMap(fileMap) {
    const dirMap = new Map();

    for (const [filePath, info] of fileMap) {
      const parts = filePath.split('/');
      const fileName = parts.pop();
      const dirKey = parts.join('/');
      if (!dirMap.has(dirKey)) dirMap.set(dirKey, []);
      dirMap.get(dirKey).push({ name: fileName, type: 'blob', hash: info.hash });
    }

    return this._buildTreeRecursive('', dirMap);
  }

  _buildTreeRecursive(dirPath, dirMap) {
    const entries = dirMap.get(dirPath) || [];

    // Find subdirectories
    const subDirs = new Set();
    for (const key of dirMap.keys()) {
      if (key === dirPath) continue;
      if (dirPath === '') {
        if (!key.includes('/')) continue;
        subDirs.add(key.split('/')[0]);
      } else if (key.startsWith(dirPath + '/')) {
        const rest = key.slice(dirPath.length + 1);
        if (rest.includes('/')) {
          subDirs.add(rest.split('/')[0]);
        }
      }
    }

    for (const subDir of subDirs) {
      const subDirPath = dirPath ? `${dirPath}/${subDir}` : subDir;
      const subTreeHash = this._buildTreeRecursive(subDirPath, dirMap);
      entries.push({ name: subDir, type: 'tree', hash: subTreeHash });
    }

    return this.objects.writeTree(entries);
  }
}

module.exports = MergeEngine;
