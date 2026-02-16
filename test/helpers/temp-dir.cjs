/**
 * Temp directory helpers for CJS tests.
 * CJS equivalent of temp-dir.js for remote/*.test.cjs files.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function createTempDir(prefix = 'cn-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

module.exports = { createTempDir, removeTempDir };
