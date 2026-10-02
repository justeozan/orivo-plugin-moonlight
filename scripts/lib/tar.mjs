// A tiny, strict ustar reader/writer.
//
// The `.orivo-plugin` format is a gzipped tar of a handful of small files, so
// the whole archive comfortably fits in memory and we can avoid a dependency
// on any third-party tar implementation. Everything here operates on Buffers.
//
// Deliberate restrictions (they are the format, not laziness):
//   * regular files only, never directory entries, symlinks or hard links;
//   * relative paths, no leading '/', no '.' or '..' segment, no backslash;
//   * fixed metadata (mode 0644, uid/gid 0, mtime 0, no owner names) so that
//     the same input tree always produces byte-identical output.

const BLOCK_SIZE = 512;
const NAME_LIMIT = 100; // ustar `name` field; we never use the `prefix` field.

// Field offsets inside a 512-byte ustar header block.
const OFFSET = {
  name: 0,
  mode: 100,
  uid: 108,
  gid: 116,
  size: 124,
  mtime: 136,
  checksum: 148,
  typeflag: 156,
  magic: 257,
  version: 263,
};

const REGULAR_FILE = '0';

/** Number -> NUL-terminated octal string of exactly `width` bytes. */
function octalField(value, width) {
  const digits = value.toString(8);
  if (digits.length > width - 1) {
    throw new RangeError(`value ${value} does not fit in a ${width}-byte octal tar field`);
  }
  return `${digits.padStart(width - 1, '0')}\0`;
}

/** Read a NUL/space-terminated octal field back into a number. */
function readOctalField(header, offset, width) {
  const raw = header.subarray(offset, offset + width).toString('ascii').replace(/[\0 ]+$/, '').trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`tar header field at offset ${offset} is not octal: ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw, 8);
}

/** Read a NUL-terminated string field. */
function readStringField(header, offset, width) {
  const field = header.subarray(offset, offset + width);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? width : end).toString('utf8');
}

/**
 * The ustar checksum is the unsigned sum of every header byte, computed with
 * the checksum field itself read as eight spaces.
 */
function headerChecksum(header) {
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    const withinChecksumField = index >= OFFSET.checksum && index < OFFSET.checksum + 8;
    sum += withinChecksumField ? 0x20 : header[index];
  }
  return sum;
}

/** Reject anything that could escape the install directory on extraction. */
export function isSafeEntryPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 256 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.endsWith('/') &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function buildHeader(path, size) {
  const header = Buffer.alloc(BLOCK_SIZE);
  const name = Buffer.from(path, 'utf8');
  if (name.length > NAME_LIMIT) {
    throw new RangeError(`entry path is longer than ${NAME_LIMIT} bytes: ${path}`);
  }

  name.copy(header, OFFSET.name);
  header.write(octalField(0o644, 8), OFFSET.mode, 'ascii');
  header.write(octalField(0, 8), OFFSET.uid, 'ascii');
  header.write(octalField(0, 8), OFFSET.gid, 'ascii');
  header.write(octalField(size, 12), OFFSET.size, 'ascii');
  header.write(octalField(0, 12), OFFSET.mtime, 'ascii');
  header.fill(0x20, OFFSET.checksum, OFFSET.checksum + 8); // placeholder: spaces
  header.write(REGULAR_FILE, OFFSET.typeflag, 'ascii');
  header.write('ustar\0', OFFSET.magic, 'ascii');
  header.write('00', OFFSET.version, 'ascii');
  // uname/gname/dev*/prefix stay zeroed: the archive must not describe the
  // machine that produced it.

  // Six octal digits, NUL, space - the form every tar implementation accepts.
  header.write(octalField(headerChecksum(header), 7), OFFSET.checksum, 'ascii');
  header.write(' ', OFFSET.checksum + 7, 'ascii');
  return header;
}

/**
 * Serialise `[{ path, data }]` into an uncompressed tar archive.
 * Entries are written in the order given; the caller owns the ordering.
 */
export function createTar(entries) {
  const blocks = [];

  for (const { path, data } of entries) {
    if (!isSafeEntryPath(path)) {
      throw new Error(`refusing to write unsafe tar entry path: ${JSON.stringify(path)}`);
    }
    blocks.push(buildHeader(path, data.length));
    blocks.push(data);
    const remainder = data.length % BLOCK_SIZE;
    if (remainder !== 0) {
      blocks.push(Buffer.alloc(BLOCK_SIZE - remainder));
    }
  }

  // Two zero blocks mark the end of the archive.
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
}

/**
 * Parse an uncompressed tar archive into `[{ path, data }]`.
 * Throws on a malformed header, an unsafe path or a non-regular entry.
 */
export function readTar(buffer) {
  if (buffer.length % BLOCK_SIZE !== 0) {
    throw new Error(`tar archive is not a whole number of ${BLOCK_SIZE}-byte blocks`);
  }

  const entries = [];
  let offset = 0;

  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break; // start of the end-of-archive marker

    const declared = readOctalField(header, OFFSET.checksum, 8);
    if (declared !== headerChecksum(header)) {
      throw new Error(`tar header checksum mismatch at byte ${offset}`);
    }

    const magic = header.subarray(OFFSET.magic, OFFSET.magic + 5).toString('ascii');
    if (magic !== 'ustar') {
      throw new Error(`tar header at byte ${offset} is not ustar`);
    }

    const typeflag = String.fromCharCode(header[OFFSET.typeflag] || 0x30);
    if (typeflag !== REGULAR_FILE && typeflag !== '\0') {
      throw new Error(`tar entry has unsupported type '${typeflag}' (regular files only)`);
    }

    const path = readStringField(header, OFFSET.name, NAME_LIMIT);
    if (!isSafeEntryPath(path)) {
      throw new Error(`tar entry has an unsafe path: ${JSON.stringify(path)}`);
    }

    const size = readOctalField(header, OFFSET.size, 12);
    const start = offset + BLOCK_SIZE;
    const end = start + size;
    if (end > buffer.length) {
      throw new Error(`tar entry '${path}' claims ${size} bytes but the archive is truncated`);
    }

    entries.push({ path, data: Buffer.from(buffer.subarray(start, end)) });
    offset = start + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }

  // Everything after the first zero block must itself be zero padding.
  if (!buffer.subarray(offset).every((byte) => byte === 0)) {
    throw new Error('tar archive contains data after the end-of-archive marker');
  }
  if (buffer.length - offset < BLOCK_SIZE * 2) {
    throw new Error('tar archive is missing its two trailing zero blocks');
  }

  return entries;
}
