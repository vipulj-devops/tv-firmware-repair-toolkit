import { composeOverlayParts } from './blockOverlay.js';

function hasOverlayWrites(overlay) {
  return overlay && typeof overlay.hasWrites === 'function' && overlay.hasWrites();
}

export function composeDumpBlob({ file, parts, replacements = {}, overlays = {} }) {
  if (!file || typeof file.slice !== 'function') throw new Error('file.slice is required');
  const changed = (parts || [])
    .filter((p) => replacements[p.name] || hasOverlayWrites(overlays[p.name]))
    .sort((a, b) => a.startByte - b.startByte);
  if (!changed.length) return file;

  const blobParts = [];
  let cursor = 0;
  for (const p of changed) {
    if (p.startByte > cursor) blobParts.push(file.slice(cursor, p.startByte));
    if (replacements[p.name]) {
      blobParts.push(replacements[p.name]);
    } else {
      const composed = composeOverlayParts(p.startByte, p.size, overlays[p.name]);
      for (const part of composed) {
        blobParts.push(part.kind === 'slice' ? file.slice(part.start, part.end) : part.data);
      }
    }
    cursor = p.startByte + p.size;
  }
  if (cursor < file.size) blobParts.push(file.slice(cursor));
  return new Blob(blobParts, { type: 'application/octet-stream' });
}

export function getPartitionBlob({ file, partition, replacements = {}, overlays = {} }) {
  if (replacements[partition.name]) {
    return new Blob([replacements[partition.name]], { type: 'application/octet-stream' });
  }
  if (hasOverlayWrites(overlays[partition.name])) {
    const overlay = overlays[partition.name];
    const blobParts = composeOverlayParts(partition.startByte, partition.size, overlay).map((part) => (
      part.kind === 'slice' ? file.slice(part.start, part.end) : part.data
    ));
    return new Blob(blobParts, { type: 'application/octet-stream' });
  }
  return file.slice(partition.startByte, partition.startByte + partition.size);
}
