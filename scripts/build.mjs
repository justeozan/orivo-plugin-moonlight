#!/usr/bin/env node
// Build the Moonlight plugin into a distributable `.orivo-plugin` package.
//
//   node scripts/build.mjs            stage package/, verify hashes, pack
//   node scripts/build.mjs --repack   re-pack dist/stage as-is (no re-hashing)
//
// Unlike a template-driven build, `package/manifest.json` already carries the
// sha256 and byteSize of every artifact: `build.sh` computes them and the
// values are pasted in (README). This build therefore never writes hashes; it
// *checks* them. A digest in the manifest that does not match the file on disk
// means `build.sh` ran again without the manifest being updated, and packing
// would ship something Orivo's `validate` would reject later - so it fails
// here instead.
//
// `--repack` exists for `sign.mjs`, which adds a signature to an already-built
// tree, and for the tamper test, which needs a package whose manifest no
// longer matches its payload.

import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DIST_DIR,
  SRC_ASSETS_DIR,
  SRC_DIR,
  STAGE_DIR,
  formatBytes,
  listFilesRecursively,
  packStagedTree,
  serialiseManifest,
  sha256Hex,
} from './lib/package.mjs';
import {
  COMPONENT_ENTRY,
  MANIFEST_ENTRY,
  SIGNATURE_ENTRY,
  validateManifest,
  validatePackageEntries,
} from './lib/manifest-rules.mjs';

const SOURCE_MANIFEST = path.join(SRC_DIR, MANIFEST_ENTRY);

function fail(headline, details = []) {
  console.error(`\nbuild failed: ${headline}`);
  for (const detail of details) console.error(`  - ${detail}`);
  process.exit(1);
}

function readSourceManifest() {
  if (!existsSync(SOURCE_MANIFEST)) fail(`missing ${SOURCE_MANIFEST}`);

  const manifest = JSON.parse(readFileSync(SOURCE_MANIFEST, 'utf8'));
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail('package/manifest.json declares no artifacts');
  }
  return manifest;
}

/** Payload files live under `package/` at exactly their package path. */
function sourcePathFor(packagePath) {
  return path.join(SRC_DIR, packagePath);
}

/** Every payload file present in package/, as package-relative paths. */
function discoverSourcePayload() {
  const found = [];
  if (existsSync(path.join(SRC_DIR, COMPONENT_ENTRY))) found.push(COMPONENT_ENTRY);
  if (existsSync(SRC_ASSETS_DIR)) {
    found.push(...listFilesRecursively(SRC_ASSETS_DIR).map((name) => `assets/${name}`));
  }
  return found;
}

/** Declared artifacts and files on disk must be the same set, in both directions. */
function checkPayloadMatchesManifest(manifest, discovered) {
  const declared = manifest.artifacts.map((artifact) => artifact.path);
  const problems = [];

  for (const declaredPath of declared) {
    const source = sourcePathFor(declaredPath);
    if (!existsSync(source) || !statSync(source).isFile()) {
      problems.push(`declared artifact has no file in package/: ${declaredPath}`);
    }
  }
  for (const foundPath of discovered) {
    if (!declared.includes(foundPath)) {
      problems.push(`file in package/ is not declared in manifest artifacts: ${foundPath}`);
    }
  }
  if (problems.length > 0) fail('package/ and package/manifest.json disagree', problems);
}

/**
 * Re-derive every digest from disk and refuse drift against the manifest, the
 * same two values `build.sh` prints and the README says to paste.
 */
function checkManifestHashes(manifest) {
  const problems = [];

  for (const artifact of manifest.artifacts) {
    const source = sourcePathFor(artifact.path);
    if (!existsSync(source)) continue;
    const bytes = readFileSync(source);
    const actualSha = sha256Hex(bytes);

    if (artifact.sha256 !== actualSha) {
      problems.push(
        `${artifact.path}: manifest sha256 ${artifact.sha256} != actual ${actualSha}`,
      );
    }
    if (artifact.byteSize !== bytes.length) {
      problems.push(
        `${artifact.path}: manifest byteSize ${artifact.byteSize} != actual ${bytes.length}`,
      );
    }
  }
  if (problems.length > 0) {
    fail('package/manifest.json is stale - re-run ./build.sh and paste the digest it prints', problems);
  }
}

/** Rebuild dist/stage from scratch: payload files plus the source manifest. */
function stage(manifest) {
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });

  for (const artifact of manifest.artifacts) {
    const destination = path.join(STAGE_DIR, artifact.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(sourcePathFor(artifact.path), destination);
  }

  writeFileSync(path.join(STAGE_DIR, MANIFEST_ENTRY), serialiseManifest(manifest));
}

function report({ file, entries, manifest, byteSize, sha256 }) {
  const signed = entries.some((entry) => entry.path === SIGNATURE_ENTRY);

  console.log(`\n${manifest.id} ${manifest.version} -> ${path.relative(process.cwd(), file)}`);
  console.log(`  archive: ${formatBytes(byteSize)}, sha256 ${sha256}`);
  console.log(`  signature: ${signed ? 'present' : 'absent (run `node scripts/sign.mjs`)'}`);
  console.log('  entries:');
  for (const entry of entries) {
    console.log(`    ${entry.path.padEnd(24)} ${String(entry.data.length).padStart(7)} B`);
  }
  console.log('');
}

function repackOnly() {
  if (!existsSync(STAGE_DIR)) fail('nothing staged yet - run `node scripts/build.mjs` first');
  console.log('re-packing dist/stage as-is (hashes are NOT recomputed)');
  report(packStagedTree());
}

function build() {
  const manifest = readSourceManifest();
  checkPayloadMatchesManifest(manifest, discoverSourcePayload());
  checkManifestHashes(manifest);

  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length > 0) fail('the manifest is not valid for Orivo', manifestErrors);

  mkdirSync(DIST_DIR, { recursive: true });
  stage(manifest);

  const packed = packStagedTree();

  const packageErrors = validatePackageEntries(manifest, packed.entries);
  if (packageErrors.length > 0) fail('the staged package is not valid for Orivo', packageErrors);

  report(packed);
}

const repack = process.argv.slice(2).includes('--repack');

// Anything thrown below this line is a build problem, not a crash worth a
// stack trace: the packer and the tar writer both refuse bad input loudly.
try {
  if (repack) repackOnly();
  else build();
} catch (error) {
  fail(error.message);
}
