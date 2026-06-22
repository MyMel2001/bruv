const path = require('path'); const fs = require('fs'); const { loadConfig, getBlockedPatterns } = require('../config');

/**
 * Security scanner for detecting sensitive files.
 * Blocks .env and similar credential files unless --danger is passed.
 */

const ALWAYS_BLOCKED = [
  /\.env$/i,
  /\.env\.[a-z0-9]+$/i,
];

const HIGH_ENTROPY_THRESHOLD = 4.5;

function shannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const freq = {};
  for (const ch of str) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  const len = str.length;
  let entropy = 0;
  for (const key of Object.keys(freq)) {
    const p = freq[key] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function matchesBlockedPattern(filePath, patterns) {
  const basename = path.basename(filePath);

  // Always block .env and .env.* files
  for (const pattern of ALWAYS_BLOCKED) {
    if (pattern.test(basename)) return true;
  }

  // Check user-configured patterns
  for (const pattern of patterns) {
    const regex = new RegExp(
      '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i'
    );
    if (regex.test(basename)) return true;
  }

  return false;
}

function isHighEntropyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 1024 * 100) return false; // skip files > 100KB
    const content = fs.readFileSync(filePath, 'utf8');
    const entropy = shannonEntropy(content);
    return entropy > HIGH_ENTROPY_THRESHOLD && content.length < 2000;
  } catch {
    return false;
  }
}

function scanFiles(files, workingDir, options = {}) {
  const config = loadConfig();
  const patterns = getBlockedPatterns(config);
  const blocked = [];
  const suspicious = [];
  const safe = [];

  for (const file of files) {
    const fullPath = path.join(workingDir, file);
    const relPath = file;

    if (matchesBlockedPattern(relPath, patterns)) {
      blocked.push({ file: relPath, reason: 'Matches blocked pattern (.env or credential file)' });
      continue;
    }

    if (isHighEntropyFile(fullPath)) {
      suspicious.push({ file: relPath, reason: 'High entropy content (possible secret/token)' });
      continue;
    }

    safe.push(relPath);
  }

  return { blocked, suspicious, safe };
}

async function aiScanFiles(files, workingDir, signal) {
  const config = loadConfig();
  const patterns = getBlockedPatterns(config);
  const blocked = [];
  const suspicious = [];
  const safe = [];

  // Always check hardcoded patterns first
  for (const file of files) {
    const fullPath = path.join(workingDir, file);

    if (matchesBlockedPattern(file, patterns)) {
      blocked.push({ file, reason: 'Matches blocked pattern (.env or credential file)' });
      continue;
    }

    suspicious.push(file);
  }

  // If AI config is available, ask AI about suspicious files
  if (suspicious.length > 0 && config.BRUV_AI_ENDPOINT && config.BRUV_AI_API_KEY) {
    const fileContents = {};
    for (const file of suspicious) {
      const fullPath = path.join(workingDir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size < 1024 * 10) {
          fileContents[file] = fs.readFileSync(fullPath, 'utf8').slice(0, 2000);
        }
      } catch { /* skip unreadable */ }
    }

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
            content: 'You are a security scanner. For each file listed, determine if it contains credentials, API keys, tokens, passwords, or other secrets. Respond with JSON: {"safe": ["file1", ...], "blocked": [{"file": "name", "reason": "..."}, ...]}. A .env file is ALWAYS blocked regardless of content. Also block .env.* files.'
          }, {
            role: 'user',
            content: JSON.stringify({ files: Object.entries(fileContents).map(([f, c]) => ({ file: f, content: c })) })
          }],
          temperature: 0,
          max_tokens: 1024,
        }),
        signal,
      });

      if (response.ok) {
        const data = await response.json();
        const aiResult = JSON.parse(data.choices?.[0]?.message?.content || '{}');
        
        const aiSafe = new Set(aiResult.safe || []);
        const aiBlockedMap = {};
        for (const b of (aiResult.blocked || [])) {
          aiBlockedMap[b.file] = b.reason;
        }

        const finalBlocked = [];
        const finalSafe = [];
        for (const file of suspicious) {
          if (aiBlockedMap[file]) {
            finalBlocked.push({ file, reason: aiBlockedMap[file] });
          } else if (aiSafe.has(file)) {
            finalSafe.push(file);
          } else {
            // Default to blocked if AI is uncertain
            finalBlocked.push({ file, reason: 'AI uncertain - potential credential file' });
          }
        }

        return { blocked: [...blocked, ...finalBlocked], suspicious: [], safe: [...safe, ...finalSafe] };
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // AI unavailable, fall through to heuristic
    }
  }

  // Without AI, fall back to high-entropy check for suspicious files
  const finalSafe = [];
  const finalBlocked = [...blocked];
  for (const file of suspicious) {
    const fullPath = path.join(workingDir, file);
    if (isHighEntropyFile(fullPath)) {
      finalBlocked.push({ file, reason: 'High entropy (possible secret)' });
    } else {
      finalSafe.push(file);
    }
  }

  return { blocked: finalBlocked, suspicious: [], safe: [...safe, ...finalSafe] };
}

module.exports = { scanFiles, aiScanFiles, matchesBlockedPattern, getBlockedPatterns };
