import { amlMptFormat } from './formats/amlMpt.js';
import { blkdevpartsMmcFormat } from './formats/blkdevpartsMmc.js';
import { emmc1630MapFormat } from './formats/emmc1630Map.js';
import { mtdpartsEmmcFormat } from './formats/mtdpartsEmmc.js';

// After AMLS / GPT / MSTAR / NVTK / HISILICON / Realtek / MBR. Do not reorder.
export const USER_AREA_STRICT_FORMATS = [
  emmc1630MapFormat,
  amlMptFormat,
  blkdevpartsMmcFormat,
  mtdpartsEmmcFormat,
];

export function detectRegisteredFormat(bytes, fileSize) {
  for (const fmt of USER_AREA_STRICT_FORMATS) {
    const hit = fmt.detect(bytes, fileSize);
    if (hit) {
      return {
        tableType: fmt.id,
        marker: hit.marker,
        soc: fmt.soc || 'unknown',
      };
    }
  }
  return null;
}

export function parseRegisteredFormat(tableType, bytes, fileSize) {
  const fmt = USER_AREA_STRICT_FORMATS.find((f) => f.id === tableType);
  return fmt ? fmt.parse(bytes, fileSize) : [];
}
