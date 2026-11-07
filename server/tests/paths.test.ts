import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { UnsafePathError, assertRealPathInside, mediaFilePath, resolveInside } from '../src/media/paths.ts';

describe('path safety', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nix360-paths-'));
  const root = path.join(workspace, 'root');
  const outside = path.join(workspace, 'outside');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'photo.jpg'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.jpg'), 'secret');

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('accepts paths inside the root and normalizes separators', () => {
    assert.equal(resolveInside(root, 'sub/photo.jpg'), path.join(root, 'sub', 'photo.jpg'));
    assert.equal(mediaFilePath([{ id: 'r', name: 'r', path: root }], { root_id: 'r', rel_path: 'sub/photo.jpg' }), path.join(root, 'sub', 'photo.jpg'));
  });

  it('rejects traversal, absolute paths and NUL bytes', () => {
    for (const candidate of ['../outside/secret.jpg', 'sub/../../outside/secret.jpg', '/etc/passwd', 'C:\\Windows\\win.ini', 'sub/\0photo.jpg', '']) {
      assert.throws(() => resolveInside(root, candidate), UnsafePathError, candidate);
    }
  });

  it('rejects a symlinked file that resolves outside the root', (t) => {
    const link = path.join(root, 'escape.jpg');
    try {
      fs.symlinkSync(path.join(outside, 'secret.jpg'), link);
    } catch {
      t.skip('symlink creation not permitted on this platform');
      return;
    }
    assert.throws(() => assertRealPathInside(root, link), UnsafePathError);
  });

  it('rejects unknown roots and missing files', () => {
    assert.throws(() => mediaFilePath([], { root_id: 'missing', rel_path: 'a.jpg' }), UnsafePathError);
    assert.throws(
      () => mediaFilePath([{ id: 'r', name: 'r', path: root }], { root_id: 'r', rel_path: 'sub/nope.jpg' }),
      UnsafePathError,
    );
  });
});
