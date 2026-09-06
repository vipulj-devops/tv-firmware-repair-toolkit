const BINARY_EXTENSIONS = /\.(bin|img|dat|fw|rom|dump)$/i;

const isBinaryFile = (path, raw) => {
  if (BINARY_EXTENSIONS.test(path)) return true;
  if (!raw || !raw.length) return false;

  const sample = raw.subarray(0, Math.min(raw.length, 1024));

  let nulCount = 0;
  let nonPrint = 0;
  let printableCount = 0;

  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) {
      nulCount++;
    } else if (b >= 32 && b <= 126) {
      printableCount++;
    } else if (b >= 9 && b <= 13) {
      printableCount++;
    } else {
      nonPrint++;
    }
  }

  const nonNulBytes = sample.length - nulCount;

  if (nonNulBytes > 0) {
    const nonNulPrintableRatio = printableCount / nonNulBytes;
    const nonNulNonPrintRatio = nonPrint / nonNulBytes;
    if (nonNulPrintableRatio >= 0.75 && nonNulNonPrintRatio < 0.08) {
      return false;
    }
  }

  return nonPrint / sample.length > 0.1;
};

export { isBinaryFile, BINARY_EXTENSIONS };
