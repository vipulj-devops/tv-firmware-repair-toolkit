import { SECTOR, ascii, hasBytes, u32le, u64le, validRange } from '../binary.js';

// Amlogic MPT (media partition table): "MPT\0" header, ASCII version, u32 count
// at +0x10, 40-byte entries at +0x18. Offsets/sizes are bytes, not LBAs.
// Distinct from AMLS-at-0 and from a later "AMLSECURITY" blob (do not scan AMLS).
const MPT = [0x4d, 0x50, 0x54, 0x00]; // "MPT\0"
const AML_MPT_HDR = 0x18;
const AML_MPT_ENT = 40;
const AML_MPT_NAME_RE = /^[\w.\-]{2,16}$/;
const AML_MPT_VER_RE = /^\d{2}\.\d{2}\.\d{2}$/;
const AML_MPT_MAX_COUNT = 64;

function isAmlMptEntry(bytes, recOff, fileSize) {
  if (recOff + AML_MPT_ENT > bytes.length) return false;
  const name = ascii(bytes, recOff, 16);
  if (!AML_MPT_NAME_RE.test(name)) return false;
  const size = u64le(bytes, recOff + 16);
  const offset = u64le(bytes, recOff + 24);
  if (offset < 0 || size < 0 || size > 0x1000000000 || offset > 0x1000000000) return false;
  if (fileSize && (offset > fileSize || offset + size > fileSize + SECTOR)) return false;
  return true;
}

function isAmlMptAt(bytes, off, fileSize) {
  if (off < 0 || off + AML_MPT_HDR + AML_MPT_ENT > bytes.length) return false;
  if (!hasBytes(bytes, off, MPT)) return false;
  const version = ascii(bytes, off + 4, 8);
  if (!AML_MPT_VER_RE.test(version)) return false;
  const count = u32le(bytes, off + 0x10);
  if (count < 1 || count > AML_MPT_MAX_COUNT) return false;
  const tableEnd = off + AML_MPT_HDR + count * AML_MPT_ENT;
  if (tableEnd > bytes.length) return false;
  for (let i = 0; i < count; i++) {
    if (!isAmlMptEntry(bytes, off + AML_MPT_HDR + i * AML_MPT_ENT, fileSize)) return false;
  }
  return true;
}

export function findAmlMpt(bytes, fileSize) {
  if (!bytes) return -1;
  const minLen = AML_MPT_HDR + AML_MPT_ENT;
  // Sector-aligned scan: ROM1 MPT is at 0x2400000. Do not search for AMLS.
  for (let o = 0; o + minLen <= bytes.length; o += SECTOR) {
    if (isAmlMptAt(bytes, o, fileSize)) return o;
  }
  return -1;
}

export function isAmlMpt(bytes, fileSize) {
  return findAmlMpt(bytes, fileSize) >= 0;
}

export function parseAmlogicMpt(bytes, fileSize) {
  const off = findAmlMpt(bytes, fileSize);
  if (off < 0) return [];
  const count = u32le(bytes, off + 0x10);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const e = off + AML_MPT_HDR + i * AML_MPT_ENT;
    const name = ascii(bytes, e, 16);
    const size = u64le(bytes, e + 16);
    const offset = u64le(bytes, e + 24);
    parts.push({ name, offset, size });
  }
  return parts;
}

export const amlMptFormat = {
  id: 'aml_mpt',
  soc: 'amlogic',
  detect(bytes, fileSize) {
    const off = findAmlMpt(bytes, fileSize);
    if (off < 0) return null;
    return { marker: `Amlogic MPT @0x${off.toString(16)}` };
  },
  parse: parseAmlogicMpt,
};
