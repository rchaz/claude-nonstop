import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { platform } from 'os';
import { isMacOS, isLinux } from '../../../lib/platform.js';

describe('isMacOS', () => {
  it('returns a boolean', () => {
    assert.equal(typeof isMacOS(), 'boolean');
  });

  it('returns true only on darwin', () => {
    if (platform() === 'darwin') {
      assert.equal(isMacOS(), true);
    } else {
      assert.equal(isMacOS(), false);
    }
  });
});

describe('isLinux', () => {
  it('returns a boolean', () => {
    assert.equal(typeof isLinux(), 'boolean');
  });

  it('returns true only on linux', () => {
    if (platform() === 'linux') {
      assert.equal(isLinux(), true);
    } else {
      assert.equal(isLinux(), false);
    }
  });
});

describe('platform exclusivity', () => {
  it('cannot be both macOS and Linux', () => {
    assert.ok(!(isMacOS() && isLinux()));
  });

  it('matches the actual platform string', () => {
    const p = platform();
    if (p === 'darwin') {
      assert.equal(isMacOS(), true);
      assert.equal(isLinux(), false);
    } else if (p === 'linux') {
      assert.equal(isMacOS(), false);
      assert.equal(isLinux(), true);
    } else {
      assert.equal(isMacOS(), false);
      assert.equal(isLinux(), false);
    }
  });
});
