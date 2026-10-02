// A JavaScript mirror of Orivo's manifest and package policy.
//
// The authority is `src-tauri/src/plugin_manifest.rs` in the Orivo repository
// (`PluginManifest::validate` and `validate_plugin_package`). This file exists
// so that a package that the host would reject fails here first, at build time,
// with a readable message - not on a user's machine at install time.
//
// Every rule below is annotated with the Rust rule it reproduces. If the host
// policy changes, change it here in the same commit.

export const SDK_V1 = 'orivo-plugin@1';

/** The Orivo release this plugin is built for; `minOrivoVersion` may not exceed it. */
export const TARGET_ORIVO_VERSION = '0.3.0';

export const MANIFEST_ENTRY = 'manifest.json';
export const COMPONENT_ENTRY = 'component.wasm';
export const SIGNATURE_ENTRY = 'signature.ed25519';

/** Ed25519 signatures are raw, not DER: exactly R (32) || S (32). */
export const SIGNATURE_BYTE_LENGTH = 64;

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 96 * 1024 * 1024;

const MAX_NAME_LENGTH = 96;
const MAX_VERSION_LENGTH = 32;
const MAX_PLUGIN_ID_LENGTH = 128;
const MAX_CAPABILITY_COUNT = 16;
const MAX_DOMAIN_COUNT = 16;
const MAX_ARTIFACT_COUNT = 32;

const EXTENSIONS = [
  'source',
  'runner',
  'metadata',
  'search',
  'automation',
  'ui_contribution',
  'installer',
];

const CAPABILITIES = [
  'library_read',
  'files_read',
  'network_fetch',
  'secrets',
  'runner_prepare',
  'notifications',
];

/** Declarative, non-executable asset types. Anything else is not an asset. */
export const ASSET_EXTENSIONS = ['json', 'svg', 'png', 'webp', 'jpg', 'jpeg', 'ftl'];

/** Native binaries and scripts: rejected outright, whatever the manifest says. */
export const BLOCKED_EXTENSIONS = ['dylib', 'so', 'dll', 'exe', 'app', 'sh', 'js', 'py', 'rb'];

const extensionOf = (path) => (path.includes('.') ? path.split('.').pop().toLowerCase() : '');

const isDuplicateFree = (values) => new Set(values).size === values.length;

/** Lowercase reverse-DNS with at least three segments, e.g. com.orivo.quiky. */
export function isValidPluginId(value) {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PLUGIN_ID_LENGTH &&
    value.split('.').length >= 3 &&
    value.split('.').every((segment) => /^[a-z][a-z0-9-]{0,62}$/.test(segment))
  );
}

/** Three numeric parts, with an optional `-prerelease` suffix. */
export function isValidSemver(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value);
}

/** `true` when `actual >= minimum`, comparing the numeric core only. */
export function versionAtLeast(actual, minimum) {
  const core = (value) => value.split('-')[0].split('.').map(Number);
  const [aMajor, aMinor, aPatch] = core(actual);
  const [mMajor, mMinor, mPatch] = core(minimum);
  if (aMajor !== mMajor) return aMajor > mMajor;
  if (aMinor !== mMinor) return aMinor > mMinor;
  return aPatch >= mPatch;
}

/** Lowercase host name, at least two labels, optional leading `*.` wildcard. */
export function normaliseDomain(value) {
  if (typeof value !== 'string') return null;
  const lowered = value.trim().toLowerCase();
  const candidate = lowered.startsWith('*.') ? lowered.slice(2) : lowered;
  const labels = candidate.split('.');
  const valid =
    candidate.length > 0 &&
    candidate.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  return valid ? lowered : null;
}

/** Relative, traversal-free, printable-ASCII path. */
export function isValidPackagePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 256 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path
      .split('/')
      .every(
        (segment) =>
          segment !== '' &&
          segment !== '.' &&
          segment !== '..' &&
          /^[\x21-\x7e]+$/.test(segment),
      )
  );
}

export const isValidAssetPath = (path) =>
  path.startsWith('assets/') && ASSET_EXTENSIONS.includes(extensionOf(path));

export const isBlockedPayloadPath = (path) => BLOCKED_EXTENSIONS.includes(extensionOf(path));

export const isValidSha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/**
 * Validate a fully populated manifest object (hashes and sizes included).
 * Returns an array of human-readable problems; empty means valid.
 */
export function validateManifest(manifest) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!manifest || typeof manifest !== 'object') return ['manifest is not a JSON object'];

  const {
    id,
    name,
    version,
    sdk,
    minOrivoVersion,
    extensions = [],
    capabilities = [],
    networkDomains = [],
    artifacts = [],
  } = manifest;

  if (!isValidPluginId(id)) fail(`id must be a lowercase reverse-DNS identifier: ${id}`);
  if (typeof name !== 'string' || name.trim() === '' || [...name].length > MAX_NAME_LENGTH) {
    fail(`name must be 1..${MAX_NAME_LENGTH} characters`);
  }
  if (!isValidSemver(version) || version.length > MAX_VERSION_LENGTH) {
    fail(`version must be a 3-part semantic version: ${version}`);
  }
  if (sdk !== SDK_V1) fail(`sdk must be exactly "${SDK_V1}" (found ${JSON.stringify(sdk)})`);

  if (minOrivoVersion !== undefined && minOrivoVersion !== null) {
    if (!isValidSemver(minOrivoVersion)) {
      fail(`minOrivoVersion must be a semantic version: ${minOrivoVersion}`);
    } else if (!versionAtLeast(TARGET_ORIVO_VERSION, minOrivoVersion)) {
      fail(`minOrivoVersion ${minOrivoVersion} is newer than Orivo ${TARGET_ORIVO_VERSION}`);
    }
  }

  if (!Array.isArray(extensions) || extensions.length === 0) {
    fail('at least one extension must be declared');
  } else {
    if (!isDuplicateFree(extensions)) fail('extensions must not contain duplicates');
    for (const extension of extensions) {
      if (!EXTENSIONS.includes(extension)) fail(`unknown extension: ${extension}`);
    }
  }

  if (!Array.isArray(capabilities) || capabilities.length > MAX_CAPABILITY_COUNT) {
    fail(`capabilities must be an array of at most ${MAX_CAPABILITY_COUNT} entries`);
  } else {
    if (!isDuplicateFree(capabilities)) fail('capabilities must not contain duplicates');
    for (const capability of capabilities) {
      if (!CAPABILITIES.includes(capability)) fail(`unknown capability: ${capability}`);
    }
  }

  if (!Array.isArray(networkDomains) || networkDomains.length > MAX_DOMAIN_COUNT) {
    fail(`networkDomains must be an array of at most ${MAX_DOMAIN_COUNT} entries`);
  } else {
    const seen = new Set();
    for (const domain of networkDomains) {
      const normalised = normaliseDomain(domain);
      if (normalised === null) fail(`networkDomains entry is not a host name: ${domain}`);
      else if (seen.has(normalised)) fail(`networkDomains entry is duplicated: ${domain}`);
      else seen.add(normalised);
    }
  }

  const declaresNetworkFetch = Array.isArray(capabilities) && capabilities.includes('network_fetch');
  const hasDomains = Array.isArray(networkDomains) && networkDomains.length > 0;
  if (declaresNetworkFetch !== hasDomains) {
    fail('networkDomains must be non-empty if and only if network_fetch is declared');
  }
  if (Array.isArray(extensions)) {
    if (extensions.includes('installer') && !declaresNetworkFetch) {
      fail('installer plugins must declare the network_fetch capability');
    }
    if (extensions.includes('runner') && !capabilities.includes('runner_prepare')) {
      fail('runner plugins must declare the runner_prepare capability');
    }
  }

  if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.length > MAX_ARTIFACT_COUNT) {
    fail(`artifacts must contain between 1 and ${MAX_ARTIFACT_COUNT} entries`);
    return errors;
  }

  const components = artifacts.filter((artifact) => artifact.kind === 'component');
  if (components.length !== 1) {
    fail(`exactly one artifact must have kind "component" (found ${components.length})`);
  }

  const seenPaths = new Set();
  let packageBytes = 0;

  for (const artifact of artifacts) {
    const { path, kind, sha256, byteSize } = artifact ?? {};
    const label = JSON.stringify(path);

    if (!isValidPackagePath(path)) fail(`artifact path is invalid: ${label}`);
    else if (seenPaths.has(path)) fail(`artifact path is duplicated: ${label}`);
    else seenPaths.add(path);

    if (kind !== 'component' && kind !== 'asset') fail(`artifact ${label} has an unknown kind: ${kind}`);
    if (!isValidSha256(sha256)) fail(`artifact ${label} needs a 64-character lowercase hex sha256`);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      fail(`artifact ${label} needs an integer byteSize`);
    } else {
      if (byteSize > MAX_ARTIFACT_BYTES) fail(`artifact ${label} exceeds ${MAX_ARTIFACT_BYTES} bytes`);
      packageBytes += byteSize;
    }

    if (kind === 'component' && path !== COMPONENT_ENTRY) {
      fail(`the component artifact must be at "${COMPONENT_ENTRY}", not ${label}`);
    }
    if (kind === 'asset' && !isValidAssetPath(path)) {
      fail(`asset ${label} must live under assets/ and be one of: ${ASSET_EXTENSIONS.join(', ')}`);
    }
    if (typeof path === 'string' && isBlockedPayloadPath(path)) {
      fail(`artifact ${label} is an executable payload and is never accepted`);
    }
  }

  if (packageBytes > MAX_PACKAGE_BYTES) fail(`declared artifacts exceed ${MAX_PACKAGE_BYTES} bytes`);

  return errors;
}

/**
 * Validate the entry list of a package against its manifest - the mirror of
 * `validate_plugin_package`. `entries` is `[{ path, data }]`.
 */
export function validatePackageEntries(manifest, entries) {
  const errors = [];
  const fail = (message) => errors.push(message);

  const allowed = new Set([
    MANIFEST_ENTRY,
    SIGNATURE_ENTRY,
    ...(manifest.artifacts ?? []).map((artifact) => artifact.path),
  ]);

  const seen = new Set();
  let totalBytes = 0;

  for (const entry of entries) {
    totalBytes += entry.data.length;

    if (!isValidPackagePath(entry.path)) fail(`package entry path is invalid: ${entry.path}`);
    if (seen.has(entry.path)) fail(`package entry is duplicated: ${entry.path}`);
    seen.add(entry.path);

    if (isBlockedPayloadPath(entry.path)) {
      fail(`package contains a forbidden native binary or script: ${entry.path}`);
    }
    if (!allowed.has(entry.path)) fail(`package contains an undeclared payload: ${entry.path}`);
  }

  if (totalBytes > MAX_PACKAGE_BYTES) fail(`package exceeds ${MAX_PACKAGE_BYTES} bytes`);
  if (!seen.has(MANIFEST_ENTRY)) fail(`package is missing ${MANIFEST_ENTRY}`);
  if (!seen.has(COMPONENT_ENTRY)) fail(`package is missing ${COMPONENT_ENTRY}`);

  for (const artifact of manifest.artifacts ?? []) {
    if (!seen.has(artifact.path)) fail(`package is missing declared artifact: ${artifact.path}`);
  }

  return errors;
}
