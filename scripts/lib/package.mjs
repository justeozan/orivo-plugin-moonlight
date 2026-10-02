// Shared paths, hashing and packing helpers for the Moonlight plugin project.
//
// Layout:
//   package/             the authored plugin: manifest.json (hashes resolved by
//                        build.sh) + component.wasm
//   dist/stage/          the exact tree that goes into the package
//   dist/*.orivo-plugin  the distributable archive
//   keys/                the local signing key (gitignored, never shipped)

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

import { createTar, readTar } from './tar.mjs';
import {
  COMPONENT_ENTRY,
  MANIFEST_ENTRY,
  SIGNATURE_ENTRY,
  isValidPackagePath,
  isBlockedPayloadPath,
} from './manifest-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(HERE, '..', '..');
export const SRC_DIR = path.join(PROJECT_ROOT, 'package');
export const SRC_ASSETS_DIR = path.join(SRC_DIR, 'assets');
export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
export const STAGE_DIR = path.join(DIST_DIR, 'stage');
export const KEYS_DIR = path.join(PROJECT_ROOT, 'keys');

export const PRIVATE_KEY_FILE = path.join(KEYS_DIR, 'orivo-release.key');
export const PUBLIC_KEY_FILE = path.join(KEYS_DIR, 'orivo-release.pub');
export const PUBLIC_KEY_BASE64_FILE = path.join(KEYS_DIR, 'orivo-release.pub.b64');

export const PACKAGE_EXTENSION = '.orivo-plugin';

export const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');
export const sha256Digest = (buffer) => createHash('sha256').update(buffer).digest();

/** Pretty-print JSON exactly the way the packaged manifest is written. */
export const serialiseManifest = (manifest) => Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

/**
 * Canonical entry order inside the archive: metadata first, then the
 * component, then assets alphabetically, then the detached signature. Fixing
 * the order keeps two builds of the same tree byte-identical.
 */
export function compareEntryPaths(left, right) {
  const rank = (entryPath) => {
    if (entryPath === MANIFEST_ENTRY) return 0;
    if (entryPath === COMPONENT_ENTRY) return 1;
    if (entryPath === SIGNATURE_ENTRY) return 3;
    return 2;
  };
  return rank(left) - rank(right) || left.localeCompare(right, 'en');
}

/** Every file under `root`, as package-relative POSIX paths. */
export function listFilesRecursively(root, prefix = '') {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...listFilesRecursively(absolute, relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

/** Read the staged tree from disk as `[{ path, data }]` in canonical order. */
export function readStagedEntries() {
  const paths = listFilesRecursively(STAGE_DIR).sort(compareEntryPaths);

  for (const entryPath of paths) {
    if (!isValidPackagePath(entryPath)) {
      throw new Error(`staged tree contains an invalid path: ${entryPath}`);
    }
    if (isBlockedPayloadPath(entryPath)) {
      throw new Error(`staged tree contains a forbidden executable payload: ${entryPath}`);
    }
  }

  return paths.map((entryPath) => ({
    path: entryPath,
    data: readFileSync(path.join(STAGE_DIR, entryPath)),
  }));
}

export function readStagedManifest() {
  const bytes = readFileSync(path.join(STAGE_DIR, MANIFEST_ENTRY));
  return { manifest: JSON.parse(bytes.toString('utf8')), bytes };
}

export const packageFileName = (manifest) =>
  `${manifest.id}-${manifest.version}${PACKAGE_EXTENSION}`;

/**
 * Tar + gzip the staged tree into `dist/<id>-<version>.orivo-plugin`.
 * Nothing is re-hashed here: the packer ships exactly what is staged, which is
 * what makes the tamper test in verify.mjs meaningful.
 */
export function packStagedTree() {
  const { manifest } = readStagedManifest();
  const entries = readStagedEntries();
  const archive = gzipSync(createTar(entries), { level: 9 });

  mkdirSync(DIST_DIR, { recursive: true });
  const file = path.join(DIST_DIR, packageFileName(manifest));
  writeFileSync(file, archive);

  return { file, entries, manifest, byteSize: archive.length, sha256: sha256Hex(archive) };
}

/** Read a `.orivo-plugin` back into `[{ path, data }]` without touching disk. */
export function unpackArchive(archive) {
  if (archive.length < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
    throw new Error('file is not gzip-compressed (missing the 1f 8b magic bytes)');
  }
  return readTar(gunzipSync(archive));
}

/** Human-friendly byte count for build output. */
export const formatBytes = (bytes) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
