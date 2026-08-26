import { composeOverlayParts } from './blockOverlay.js';

function hasOverlayWrites(overlay) {
  return overlay && typeof overlay.hasWrites === 'function' && overlay.hasWrites();
}

function physicalSize(p, fileSize) {
  if (p.unavailable || p.startByte >= fileSize) return 0;
  const avail = p.availableSize ?? p.size;
  if (!(avail > 0)) return 0;
  return Math.min(avail, fileSize - p.startByte);
}

export function composeDumpBlob({ file, parts, replacements = {}, overlays = {} }) {
  if (!file || typeof file.slice !== 'function') throw new Error('file.slice is required');
  const fileSize = file.size;
  const changed = (parts || [])
    .filter((p) => replacements[p.name] || hasOverlayWrites(overlays[p.name]))
    .sort((a, b) => a.startByte - b.startByte);
  if (!changed.length) return file;

  const blobParts = [];
  let cursor = 0;
  let wrote = false;
  for (const p of changed) {
    const phys = physicalSize(p, fileSize);
    if (phys <= 0) continue;
    wrote = true;
    if (p.startByte > cursor) blobParts.push(file.slice(cursor, Math.min(p.startByte, fileSize)));
    if (replacements[p.name]) {
      blobParts.push(replacements[p.name]);
    } else {
      const composed = composeOverlayParts(p.startByte, phys, overlays[p.name]);
      for (const part of composed) {
        blobParts.push(part.kind === 'slice' ? file.slice(part.start, Math.min(part.end, fileSize)) : part.data);
      }
    }
    cursor = Math.min(p.startByte + phys, fileSize);
  }
  if (!wrote) return file;
  if (cursor < fileSize) blobParts.push(file.slice(cursor, fileSize));
  return new Blob(blobParts, { type: 'application/octet-stream' });
}

export function getPartitionBlob({ file, partition, replacements = {}, overlays = {} }) {
  const readSize = partition.availableSize ?? partition.size;
  if (partition.unavailable || readSize <= 0) {
    return new Blob([], { type: 'application/octet-stream' });
  }
  if (replacements[partition.name]) {
    return new Blob([replacements[partition.name]], { type: 'application/octet-stream' });
  }
  if (hasOverlayWrites(overlays[partition.name])) {
    const overlay = overlays[partition.name];
    const blobParts = composeOverlayParts(partition.startByte, readSize, overlay).map((part) => (
      part.kind === 'slice' ? file.slice(part.start, part.end) : part.data
    ));
    return new Blob(blobParts, { type: 'application/octet-stream' });
  }
  return file.slice(partition.startByte, partition.startByte + readSize);
}
