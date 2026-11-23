'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');
const { parseArgs, checkPrereqs, builderArgs, currentTarget } = require('../scripts/release');

const { needsNoSandbox, suidSandboxOk, userNamespacesOk } = require('../scripts/start');

const root = path.join(__dirname, '..');

test('build config: Ubuntu/Debian (deb), Fedora/openSUSE (rpm), Windows 64+32, macOS Intel+Apple Silicon', () => {
  const b = pkg.build;
  const linux = b.linux.target.map((t) => t.target);
  for (const t of ['deb', 'rpm', 'AppImage', 'tar.gz']) assert.ok(linux.includes(t), `linux ${t}`);
  const nsis = b.win.target.find((t) => t.target === 'nsis');
  assert.deepStrictEqual([...nsis.arch].sort(), ['ia32', 'x64']);
  const dmg = b.mac.target.find((t) => t.target === 'dmg');
  assert.deepStrictEqual([...dmg.arch].sort(), ['arm64', 'x64']);
  assert.strictEqual(b.nsis.buildUniversalInstaller, false, 'um instalador por arquitetura (x64 e ia32)');
  assert.notStrictEqual(b.nsis.artifactName, b.portable.artifactName, 'installer and portable must not share a name');
  assert.strictEqual(b.appId, 'dev.natancabral.llamafile-brain');
});

test('required package files exist (icons, license, main) and the tests folder is not packaged', () => {
  for (const f of ['build/icon.png', 'build/icon.ico', 'build/icon.icns', 'build/icons/256x256.png', 'build/icons/16x16.png', 'assets/logo.svg', 'assets/icon.svg', 'LICENSE', pkg.main]) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
  assert.ok(!pkg.build.files.some((f) => /test/.test(f) && !f.startsWith('!')));
  assert.strictEqual(pkg.author.name, 'Natan Cabral');
});

test('release.js: arguments, per-system prerequisites and electron-builder commands', () => {
  assert.deepStrictEqual(parseArgs(['--linux', '--win']), { linux: true, win: true, mac: false, dir: false });
  assert.throws(() => parseArgs(['--xyz']), /Unknown option/);
  assert.strictEqual(currentTarget('linux'), 'linux');
  assert.strictEqual(currentTarget('win32'), 'win');
  assert.strictEqual(currentTarget('darwin'), 'mac');

  assert.ok(!checkPrereqs('mac', 'linux').ok, 'mac only on macOS');
  assert.ok(checkPrereqs('mac', 'darwin').ok);
  assert.ok(!checkPrereqs('linux', 'linux', () => false).ok, 'rpm needs rpmbuild');
  assert.match(checkPrereqs('linux', 'linux', () => false).errors[0], /rpmbuild/);
  assert.ok(checkPrereqs('linux', 'linux', () => true).ok);
  assert.ok(!checkPrereqs('linux', 'win32').ok);
  assert.ok(!checkPrereqs('win', 'linux', () => false).ok, 'win from Linux needs wine');
  assert.ok(checkPrereqs('win', 'linux', (c) => c === 'wine').ok);
  assert.ok(checkPrereqs('win', 'win32').ok);

  assert.deepStrictEqual(builderArgs('win'), ['--win', '--x64', '--ia32', '--publish', 'never']);
  assert.deepStrictEqual(builderArgs('mac'), ['--mac', '--x64', '--arm64', '--publish', 'never']);
  assert.deepStrictEqual(builderArgs('linux', { dir: true }), ['--linux', '--x64', '--dir', '--publish', 'never']);
});

test('start.js: --no-sandbox only on Linux and only when neither sandbox can work', () => {
  assert.strictEqual(needsNoSandbox({ platform: 'win32' }), false);
  assert.strictEqual(needsNoSandbox({ platform: 'darwin' }), false);
  assert.strictEqual(needsNoSandbox({ platform: 'linux', suid: true }), false, 'setuid helper works');
  assert.strictEqual(needsNoSandbox({ platform: 'linux', suid: false, userns: true }), false, 'user namespaces work');
  assert.strictEqual(needsNoSandbox({ platform: 'linux', suid: false, userns: false }), true);
  assert.strictEqual(needsNoSandbox({ platform: 'linux', suid: false, userns: false, args: ['--no-sandbox'] }), false, 'already requested');
  // helper checks
  assert.strictEqual(suidSandboxOk('/x', { stat: () => ({ uid: 0, mode: 0o104755 }), mountOptions: () => 'rw,relatime' }), true);
  assert.strictEqual(suidSandboxOk('/x', { stat: () => ({ uid: 0, mode: 0o104755 }), mountOptions: () => 'rw,nosuid' }), false, 'nosuid mount');
  assert.strictEqual(suidSandboxOk('/x', { stat: () => ({ uid: 1000, mode: 0o100755 }), mountOptions: () => '' }), false, 'not root / no setuid bit');
  // Ubuntu 24.04+: unshare is allowed by AppArmor, everything else is not
  const sys = (map) => (f) => { if (f in map) return String(map[f]); throw new Error('ENOENT'); };
  assert.strictEqual(userNamespacesOk({ read: sys({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': 1 }), probe: () => true }), false);
  assert.strictEqual(userNamespacesOk({ read: sys({ '/proc/sys/user/max_user_namespaces': 0 }), probe: () => true }), false);
  assert.strictEqual(userNamespacesOk({ read: sys({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': 0 }), probe: () => true }), true);
  assert.strictEqual(userNamespacesOk({ read: sys({}), probe: () => false }), false);
});
