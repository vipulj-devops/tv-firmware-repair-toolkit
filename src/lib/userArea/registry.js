import { amlMptFormat } from './formats/amlMpt.js';
import { blkdevpartsMmcFormat } from './formats/blkdevpartsMmc.js';
import { hisiEmmcMapFormat } from './formats/hisiEmmcMap.js';

// After AMLS / GPT / MSTAR / NVTK / HISILICON / Realtek / MBR. Do not reorder.
export const USER_AREA_STRICT_FORMATS = [
  hisiEmmcMapFormat,
  amlMptFormat,
  blkdevpartsMmcFormat,
];

export function detectRegisteredFormat(bytes, fileSize) {
  for (const fmt of USER_AREA_STRICT_FORMATS) {
    const hit = fmt.detect(bytes, fileSize);
    if (hit) return { soc: fmt.soc, tableType: fmt.id, marker: hit.marker };
  }
  return null;
}

export function parseRegisteredFormat(tableType, bytes, fileSize) {
  const fmt = USER_AREA_STRICT_FORMATS.find((f) => f.id === tableType);
  return fmt ? fmt.parse(bytes, fileSize) : [];
}
