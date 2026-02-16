/**
 * Temp directory helpers for tests.
 * Creates isolated temp dirs and cleans them up after tests.
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Create a temporary directory with a given prefix.
 * @param {string} prefix
 * @returns {string} path to the temp directory
 */
export function createTempDir(prefix = 'cn-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Remove a temporary directory recursively.
 * @param {string} dir
 */
export function removeTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}
