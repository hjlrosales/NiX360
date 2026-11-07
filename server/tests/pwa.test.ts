import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import sharp from 'sharp';

const webRoot = path.resolve(import.meta.dirname, '..', '..', 'web');
const manifestPath = path.join(webRoot, 'public', 'manifest.webmanifest');
const workerPath = path.join(webRoot, 'public', 'sw.js');

test('the PWA manifest is installable and every declared icon exists', async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };

  assert.equal(manifest.name, 'NiX 360 Media');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));

  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    const file = path.join(webRoot, 'public', icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `${icon.src} is present`);
    const [width, height] = icon.sizes.split('x').map(Number);
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, height);
  }

  const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /apple-touch-icon/);
});

test('the service worker parses and keeps private API responses out of the shell', () => {
  const source = fs.readFileSync(workerPath, 'utf8');
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'sw.js' }));

  // The worker must identify the one cacheable private representation and use
  // an account-scoped cache name. Other API responses are network-only.
  assert.match(source, /THUMBNAIL_PATH = \/\^\\\/api\\\/media/);
  assert.match(source, /nix360-offline-/);
  assert.match(source, /clear-offline/);
  assert.match(source, /request\.method !== 'GET'/);
  assert.doesNotMatch(source, /caches\.match\(request\)\.then/);
});
