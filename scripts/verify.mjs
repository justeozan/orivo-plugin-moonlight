#!/usr/bin/env node
// Verify a `.orivo-plugin` package the way Orivo will.
//
//   node scripts/verify.mjs                        verify the newest dist/ package
//   node scripts/verify.mjs <file>                 verify a specific package
//   node scripts/verify.mjs <file> --public-key <base64|pem-file>
//   node scripts/verify.mjs <file> --require-signature
//
// Nothing is extracted to disk: the archive is gunzipped and untarred in
// memory, then every claim the manifest makes is re-checked against the bytes
// that actually shipped. Any mismatch exits non-zero.
//
// This is the project's test harness. If it passes, the package satisfies the
// v1 rules in Orivo's `plugin_manifest.rs`; if it fails, the host would have
// rejected the package at install time.

import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  DIST_DIR,
  PACKAGE_EXTENSION,
  PROJECT_ROOT,
  PUBLIC_KEY_BASE64_FILE,
  PUBLIC_KEY_FILE,
  formatBytes,
  sha256Digest,
  sha256Hex,
  unpackArchive,
} from './lib/package.mjs';
import {
  ASSET_EXTENSIONS,
  COMPONENT_ENTRY,
  MANIFEST_ENTRY,
  SIGNATURE_BYTE_LENGTH,
  SIGNATURE_ENTRY,
  isBlockedPayloadPath,
  isValidAssetPath,
  validateManifest,
  validatePackageEntries,
} from './lib/manifest-rules.mjs';

// ---------------------------------------------------------------- reporting

const results = [];
const pass = (label, detail = '') => results.push({ ok: true, label, detail });
const fail = (label, detail = '') => results.push({ ok: false, label, detail });

function abort(message) {
  console.error(`\nFAIL  ${message}\n`);
  process.exit(1);
}

function summarise(file) {
  const failures = results.filter((result) => !result.ok);

  console.log(`\nverifying ${path.relative(process.cwd(), file)}\n`);
  for (const { ok, label, detail } of results) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  }

  if (failures.length === 0) {
    console.log(`\n${results.length} checks passed - package is valid.\n`);
    process.exit(0);
  }
  console.log(`\n${failures.length} of ${results.length} checks FAILED - package is invalid.\n`);
  process.exit(1);
}

// ------------------------------------------------------------- argv parsing

function parseArguments(argv) {
  const positional = [];
  let publicKey = null;
  let requireSignature = false;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--public-key') publicKey = argv[++index];
    else if (argv[index] === '--require-signature') requireSignature = true;
    else positional.push(argv[index]);
  }
  return { file: positional[0] ?? null, publicKey, requireSignature };
}

/** Newest `dist/*.orivo-plugin`, so plain `npm run verify` does the obvious thing. */
function newestBuiltPackage() {
  if (!existsSync(DIST_DIR)) return null;
  const candidates = readdirSync(DIST_DIR)
    .filter((name) => name.endsWith(PACKAGE_EXTENSION))
    .map((name) => path.join(DIST_DIR, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0] ?? null;
}

/** A base64 raw key, a PEM file, a raw-base64 file, or the project default. */
function loadPublicKey(argument) {
  const fromPem = (pem) => createPublicKey(pem);
  const fromBase64 = (base64) =>
    createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(base64, 'base64').toString('base64url') },
      format: 'jwk',
    });

  if (argument) {
    if (existsSync(argument)) {
      const contents = readFileSync(argument, 'utf8');
      const key = contents.includes('BEGIN') ? fromPem(contents) : fromBase64(contents.trim());
      return { key, source: path.relative(PROJECT_ROOT, path.resolve(argument)) };
    }
    return { key: fromBase64(argument.trim()), source: '--public-key' };
  }
  if (existsSync(PUBLIC_KEY_BASE64_FILE)) {
    return {
      key: fromBase64(readFileSync(PUBLIC_KEY_BASE64_FILE, 'utf8').trim()),
      source: path.relative(PROJECT_ROOT, PUBLIC_KEY_BASE64_FILE),
    };
  }
  if (existsSync(PUBLIC_KEY_FILE)) {
    return {
      key: fromPem(readFileSync(PUBLIC_KEY_FILE, 'utf8')),
      source: path.relative(PROJECT_ROOT, PUBLIC_KEY_FILE),
    };
  }
  return { key: null, source: null };
}

// -------------------------------------------------------------------- checks

function checkEntryShape(entries) {
  const paths = entries.map((entry) => entry.path);

  if (paths.includes(MANIFEST_ENTRY)) pass(`${MANIFEST_ENTRY} present`);
  else fail(`${MANIFEST_ENTRY} present`, 'missing');

  if (paths.includes(COMPONENT_ENTRY)) pass(`${COMPONENT_ENTRY} present`);
  else fail(`${COMPONENT_ENTRY} present`, 'missing');

  const blocked = paths.filter(isBlockedPayloadPath);
  if (blocked.length === 0) pass('no executable payloads');
  else fail('no executable payloads', blocked.join(', '));

  const strayAssets = paths.filter(
    (entryPath) => entryPath.startsWith('assets/') && !isValidAssetPath(entryPath),
  );
  if (strayAssets.length === 0) pass(`assets are declarative (${ASSET_EXTENSIONS.join('/')})`);
  else fail('assets are declarative', strayAssets.join(', '));

  const duplicates = paths.filter((entryPath, index) => paths.indexOf(entryPath) !== index);
  if (duplicates.length === 0) pass('no duplicate entries');
  else fail('no duplicate entries', duplicates.join(', '));
}

function checkArtifacts(manifest, entries) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry.data]));

  for (const artifact of manifest.artifacts ?? []) {
    const data = byPath.get(artifact.path);
    const label = `artifact ${artifact.path}`;

    if (!data) {
      fail(label, 'declared in the manifest but absent from the package');
      continue;
    }
    if (data.length !== artifact.byteSize) {
      fail(`${label} byteSize`, `manifest says ${artifact.byteSize}, package has ${data.length}`);
    } else {
      pass(`${label} byteSize`, `${artifact.byteSize} B`);
    }

    const actual = sha256Hex(data);
    if (actual !== artifact.sha256) {
      fail(`${label} sha256`, `manifest says ${artifact.sha256}, package has ${actual}`);
    } else {
      pass(`${label} sha256`, actual);
    }
  }
}

function checkSignature(entries, manifestBytes, { publicKey, requireSignature }) {
  const signature = entries.find((entry) => entry.path === SIGNATURE_ENTRY)?.data;

  if (!signature) {
    if (requireSignature) fail('signature', `${SIGNATURE_ENTRY} is missing and --require-signature was given`);
    else pass('signature', 'absent (unsigned build)');
    return;
  }

  if (signature.length !== SIGNATURE_BYTE_LENGTH) {
    fail('signature length', `expected ${SIGNATURE_BYTE_LENGTH} raw bytes, got ${signature.length}`);
    return;
  }
  pass('signature length', `${SIGNATURE_BYTE_LENGTH} raw bytes`);

  const { key, source } = loadPublicKey(publicKey);
  if (!key) {
    if (requireSignature) fail('signature', 'no public key available to verify against');
    else pass('signature', 'present but unverified (no public key; pass --public-key)');
    return;
  }

  const digest = sha256Digest(manifestBytes);
  if (verifySignature(null, digest, key, signature)) {
    pass('signature verifies', `over sha256(manifest.json) using ${source}`);
  } else {
    fail('signature verifies', `does not match sha256(manifest.json) under ${source}`);
  }
}

// ---------------------------------------------------------------------- main

const options = parseArguments(process.argv.slice(2));
const file = options.file ? path.resolve(options.file) : newestBuiltPackage();

if (!file) abort('no package given and nothing built in dist/ - run `npm run build` first');
if (!existsSync(file)) abort(`no such file: ${file}`);

const archive = readFileSync(file);

let entries;
try {
  entries = unpackArchive(archive);
} catch (error) {
  abort(`the archive could not be read: ${error.message}`);
}
pass('gzip + tar readable', `${entries.length} entries, ${formatBytes(archive.length)} on disk`);

checkEntryShape(entries);

const manifestBytes = entries.find((entry) => entry.path === MANIFEST_ENTRY)?.data;
if (!manifestBytes) summarise(file);

let manifest;
try {
  manifest = JSON.parse(manifestBytes.toString('utf8'));
  pass('manifest.json parses');
} catch (error) {
  fail('manifest.json parses', error.message);
  summarise(file);
}

for (const problem of validateManifest(manifest)) fail('manifest policy', problem);
for (const problem of validatePackageEntries(manifest, entries)) fail('package policy', problem);
if (results.every((result) => result.ok)) {
  pass('manifest and package satisfy the v1 policy', `${manifest.id} ${manifest.version}`);
}

checkArtifacts(manifest, entries);
checkSignature(entries, manifestBytes, options);

summarise(file);
