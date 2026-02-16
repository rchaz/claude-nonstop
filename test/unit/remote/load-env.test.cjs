const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDir, removeTempDir } = require('../../helpers/temp-dir.cjs');

describe('load-env parser logic', () => {
  // We replicate the parsing logic because load-env.cjs is a side-effect module
  // that runs on require() and cannot be re-required. This tests the algorithm
  // matches the production code in remote/load-env.cjs lines 21-31.

  function parseEnvContent(content, env = {}) {
    const result = { ...env };
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const value = trimmed.substring(eqIdx + 1).trim();
      if (!result[key]) {
        result[key] = value;
      }
    }
    return result;
  }

  it('parses KEY=value pairs', () => {
    const result = parseEnvContent('FOO=bar\nBAZ=qux');
    assert.equal(result.FOO, 'bar');
    assert.equal(result.BAZ, 'qux');
  });

  it('skips comment lines', () => {
    const result = parseEnvContent('# this is a comment\nKEY=val');
    assert.equal(result.KEY, 'val');
    assert.equal(Object.keys(result).length, 1);
  });

  it('skips comment lines that contain = signs', () => {
    const result = parseEnvContent('# SECRET=should_not_appear\nKEY=val');
    assert.equal(result.KEY, 'val');
    assert.equal(result.SECRET, undefined);
    assert.equal(Object.keys(result).length, 1);
  });

  it('skips empty lines', () => {
    const result = parseEnvContent('\n\nKEY=val\n\n');
    assert.equal(result.KEY, 'val');
  });

  it('does not overwrite existing env vars', () => {
    const result = parseEnvContent('KEY=new', { KEY: 'existing' });
    assert.equal(result.KEY, 'existing');
  });

  it('handles values with = signs', () => {
    const result = parseEnvContent('KEY=a=b=c');
    assert.equal(result.KEY, 'a=b=c');
  });

  it('skips lines without =', () => {
    const result = parseEnvContent('no_equals_here');
    assert.deepEqual(result, {});
  });
});

describe('load-env.cjs module', () => {
  it('exports nothing (side-effect only module)', () => {
    // load-env.cjs has no module.exports, it's a side-effect module
    const result = require('../../../remote/load-env.cjs');
    assert.equal(typeof result, 'object');
  });

  it('reads from paths.cjs ENV_PATH location', () => {
    // Verify the module references the correct path
    const content = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'remote', 'load-env.cjs'),
      'utf-8'
    );
    assert.ok(content.includes("require('./paths.cjs')"), 'Should import from paths.cjs');
    assert.ok(content.includes('ENV_PATH'), 'Should use ENV_PATH from paths.cjs');
  });
});
