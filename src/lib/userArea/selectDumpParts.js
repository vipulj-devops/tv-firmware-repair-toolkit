import { userAreaToParts } from '../userAreaParser.js';

export const STRICT_USER_AREA_TYPES = ['emmc_1630_5840', 'aml_mpt', 'blkdevparts_mmc', 'mtdparts_emmc'];

const STRICT = new Set(STRICT_USER_AREA_TYPES);

// PartitionTable source: valid GPT, then a non-empty strict registry map,
// then usable primary MBR (gptParts from autoMapPartitions when !hasGpt),
// then heuristic user-area parts, then firmware-package fallback.
export function selectDumpParts({ hasGpt, gptParts, userAreaAnalysis, firmwareParts }) {
  const gpt = gptParts || [];
  const ua = userAreaToParts(userAreaAnalysis);
  if (hasGpt) return gpt;
  if (userAreaAnalysis && STRICT.has(userAreaAnalysis.tableType) && ua.length >= 1) return ua;
  if (gpt.length >= 1) return gpt;
  if (ua.length >= 1) return ua;
  return firmwareParts || [];
}
