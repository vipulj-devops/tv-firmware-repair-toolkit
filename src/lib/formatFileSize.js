// Binary units: 1 KB = 1024, 1 MB = 1024^2, 1 GB = 1024^3.
const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

function toBytes(n) {
  if (typeof n === 'bigint') {
    const asNum = Number(n);
    return Number.isSafeInteger(asNum) ? asNum : NaN;
  }
  if (n == null || n === '') return NaN;
  const bytes = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(bytes) ? bytes : NaN;
}

export function formatFileSize(n) {
  const bytes = toBytes(n);
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(2)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}
