const UBOOT_HEADER_SIZE = 4;

function crc32_ieee(buf) {
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function detectUbootEnv(raw) {
  if (!raw || raw.length < UBOOT_HEADER_SIZE + 4) return null;

  const storedCrcLe = (raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24)) >>> 0;
  const payload = raw.subarray(UBOOT_HEADER_SIZE);
  const calcCrc = crc32_ieee(payload);

  if (storedCrcLe !== calcCrc) return null;

  let nulCount = 0;
  let nonPrint = 0;
  let printableCount = 0;
  let firstNulAfterText = -1;
  let maxPrintableRun = 0;
  let currentRun = 0;

  for (let i = 0; i < payload.length; i++) {
    const b = payload[i];
    if (b === 0) {
      nulCount++;
      if (firstNulAfterText === -1 && printableCount > 0) {
        firstNulAfterText = i;
      }
      currentRun = 0;
    } else if (b >= 32 && b <= 126) {
      printableCount++;
      currentRun++;
      if (currentRun > maxPrintableRun) maxPrintableRun = currentRun;
    } else if (b >= 9 && b <= 13) {
      printableCount++;
      currentRun = 0;
    } else {
      nonPrint++;
      currentRun = 0;
    }
  }

  const nonNulBytes = payload.length - nulCount;
  if (nonNulBytes === 0) return null;

  const printableRatio = printableCount / nonNulBytes;
  const nonPrintRatio = nonPrint / nonNulBytes;

  if (printableRatio >= 0.9 && nonPrintRatio < 0.02 && nulCount > 10 && maxPrintableRun >= 10) {
    return {
      headerLength: UBOOT_HEADER_SIZE,
      crc32: storedCrcLe,
    };
  }

  return null;
}

function detectUtf8Validity(raw) {
  if (!raw || raw.length === 0) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return true;
  } catch {
    return false;
  }
}

function decodeTextFile(raw, path) {
  if (!raw || raw.length === 0) {
    return {
      displayText: '',
      meta: {
        encoding: 'utf-8',
        header: { present: false, length: 0, type: 'none', rawBytes: new Uint8Array(0) },
        separator: { byte: 0x00, displayAs: '\n', usedForDisplay: false },
        allocationSize: 0,
        originalSize: 0,
        isValidUtf8: true,
        isUbootEnv: false,
      },
    };
  }

  const uboot = detectUbootEnv(raw);
  const isValidUtf8 = detectUtf8Validity(raw);

  if (uboot) {
    const payload = raw.subarray(UBOOT_HEADER_SIZE);
    const headerBytes = new Uint8Array(UBOOT_HEADER_SIZE);
    headerBytes.set(raw.subarray(0, UBOOT_HEADER_SIZE));

    let contentEnd = payload.length;
    for (let i = payload.length - 1; i >= 0; i--) {
      if (payload[i] !== 0) {
        contentEnd = i + 1;
        break;
      }
      contentEnd = i;
    }
    if (contentEnd === 0) {
      contentEnd = payload.length;
      for (let i = 0; i < payload.length; i++) {
        if (payload[i] === 0) {
          contentEnd = i;
          break;
        }
      }
    }

    const meaningfulPayload = payload.subarray(0, contentEnd);
    let text = new TextDecoder('utf-8', { fatal: false }).decode(meaningfulPayload);
    text = text.replace(/\0/g, '\n');

    return {
      displayText: text,
      meta: {
        encoding: 'utf-8',
        header: {
          present: true,
          length: UBOOT_HEADER_SIZE,
          type: 'uboot-crc32',
          rawBytes: headerBytes,
          crc32: uboot.crc32,
        },
        separator: { byte: 0x00, displayAs: '\n', usedForDisplay: true },
        payloadEnd: contentEnd,
        allocationSize: raw.length,
        originalSize: raw.length,
        isValidUtf8: isValidUtf8,
        isUbootEnv: true,
      },
    };
  }

  let encoding = 'utf-8';
  let text;

  if (isValidUtf8) {
    text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
  } else {
    text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
    encoding = 'utf-8-fallback';
  }

  const nulCount = text.split('\0').length - 1;
  let usedNulSeparator = false;
  if (nulCount > 0) {
    usedNulSeparator = true;
    text = text.replace(/\0+$/, '');
    text = text.replace(/\0/g, '\n');
  }

  return {
    displayText: text,
    meta: {
      encoding,
      header: { present: false, length: 0, type: 'none', rawBytes: new Uint8Array(0) },
      separator: { byte: 0x00, displayAs: '\n', usedForDisplay: usedNulSeparator },
      allocationSize: raw.length,
      originalSize: raw.length,
      isValidUtf8,
      isUbootEnv: false,
    },
  };
}

function encodeTextFile(meta, editedText) {
  if (meta.isUbootEnv) {
    const contentWithNuls = editedText.replace(/\n/g, '\0');
    const payload = new TextEncoder().encode(contentWithNuls);

    const headerLen = meta.header.length || UBOOT_HEADER_SIZE;
    const totalAlloc = meta.allocationSize || meta.originalSize || (headerLen + payload.length);
    const payloadAlloc = totalAlloc - headerLen;
    if (payload.length > payloadAlloc) {
      throw new Error(
        `Edited U-Boot environment content (${payload.length} bytes) exceeds the maximum payload capacity (${payloadAlloc} bytes).`
      );
    }
    const padded = new Uint8Array(payloadAlloc);
    padded.set(payload, 0);

    const crc = crc32_ieee(padded);
    const header = new Uint8Array(headerLen);
    header[0] = crc & 0xFF;
    header[1] = (crc >> 8) & 0xFF;
    header[2] = (crc >> 16) & 0xFF;
    header[3] = (crc >> 24) & 0xFF;

    const result = new Uint8Array(header.length + padded.length);
    result.set(header, 0);
    result.set(padded, header.length);
    return result;
  }

  const encoder = new TextEncoder();
  let encoded = encoder.encode(editedText);

  if (meta.separator?.usedForDisplay) {
    const contentWithNuls = editedText.replace(/\n/g, '\0');
    encoded = encoder.encode(contentWithNuls);
  }

  const originalSize = meta.originalSize || encoded.length;
  if (encoded.length <= originalSize) {
    const result = new Uint8Array(originalSize);
    result.set(encoded);
    return result;
  }
  return encoded;
}

export { decodeTextFile, encodeTextFile, crc32_ieee, detectUbootEnv, UBOOT_HEADER_SIZE };
