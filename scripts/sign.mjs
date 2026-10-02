#!/usr/bin/env node
// Sign a built Moonlight package.
//
//   node scripts/sign.mjs                  sign with keys/orivo-release.key
//   node scripts/sign.mjs --key <pem>      sign with another PKCS#8 PEM key
//
// What is signed: the SHA-256 digest (32 raw bytes) of the packaged
// `manifest.json`, exactly as those bytes appear in the archive. The manifest
// in turn pins the sha256 of every artifact, so one signature covers the whole
// payload without the signer having to hash it again.
//
// The signature is written as `signature.ed25519`: 64 raw bytes, no PEM, no
// base64, no DER. Then the staged tree is re-packed so the archive contains it.

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  PRIVATE_KEY_FILE,
  PROJECT_ROOT,
  STAGE_DIR,
  formatBytes,
  packStagedTree,
  readStagedManifest,
  sha256Digest,
} from './lib/package.mjs';
import { SIGNATURE_BYTE_LENGTH, SIGNATURE_ENTRY } from './lib/manifest-rules.mjs';

function fail(message, hint) {
  console.error(`\nsign failed: ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

/** `--key <path>` overrides the default key location. */
function resolveKeyFile(argv) {
  const flag = argv.indexOf('--key');
  return flag === -1 ? PRIVATE_KEY_FILE : path.resolve(argv[flag + 1] ?? '');
}

const keyFile = resolveKeyFile(process.argv.slice(2));

if (!existsSync(STAGE_DIR)) {
  fail('nothing has been built yet', 'run `node scripts/build.mjs` first');
}
if (!existsSync(keyFile)) {
  fail(`no signing key at ${path.relative(PROJECT_ROOT, keyFile)}`, 'copy Orivo\'s release key there (see README)');
}

const privateKey = createPrivateKey(readFileSync(keyFile));
if (privateKey.asymmetricKeyType !== 'ed25519') {
  fail(`signing key is ${privateKey.asymmetricKeyType}, not ed25519`);
}
const publicKey = createPublicKey(privateKey);

const { manifest, bytes: manifestBytes } = readStagedManifest();
const digest = sha256Digest(manifestBytes);

// Ed25519 takes the message directly, so the algorithm argument is null: the
// digest below is our message, not a pre-hash that node should hash again.
const signature = sign(null, digest, privateKey);
if (signature.length !== SIGNATURE_BYTE_LENGTH) {
  fail(`expected a ${SIGNATURE_BYTE_LENGTH}-byte signature, got ${signature.length}`);
}
if (!verify(null, digest, publicKey, signature)) {
  fail('the freshly made signature did not verify against its own public key');
}

writeFileSync(path.join(STAGE_DIR, SIGNATURE_ENTRY), signature);

let packed;
try {
  packed = packStagedTree();
} catch (error) {
  fail(error.message);
}
const { x } = publicKey.export({ format: 'jwk' });

console.log(`\nsigned ${manifest.id} ${manifest.version}`);
console.log(`  key:              ${path.relative(process.cwd(), keyFile)}`);
console.log(`  manifest sha256:  ${digest.toString('hex')}`);
console.log(`  signature:        ${signature.length} raw bytes -> ${SIGNATURE_ENTRY}`);
console.log(`  public key (b64): ${Buffer.from(x, 'base64url').toString('base64')}`);
console.log(`  repacked:         ${path.relative(process.cwd(), packed.file)} (${formatBytes(packed.byteSize)})`);
console.log('');
