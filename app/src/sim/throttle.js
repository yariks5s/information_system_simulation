// MergeTreeData::delayInsertOrThrowIfNeeded with the linear delay of 23.1 and later

// null is TOO_MANY_PARTS, otherwise the delay in ms; the counts are of the partition with the most parts
export function checkInsert(partsCount, partitionBytes, cfg, totalParts = partsCount) {
  if (totalParts >= cfg.max_parts_in_total) return null;
  const average = partsCount ? Math.floor(partitionBytes / partsCount) : 0;
  // large parts lift both the delay and the rejection
  if (cfg.max_avg_part_size_for_too_many_parts && average > cfg.max_avg_part_size_for_too_many_parts) return 0;
  if (partsCount >= cfg.parts_to_throw_insert) return null;
  if (!cfg.parts_to_delay_insert || partsCount < cfg.parts_to_delay_insert) return 0;
  const over = partsCount - cfg.parts_to_delay_insert + 1;
  const allowed = cfg.parts_to_throw_insert - cfg.parts_to_delay_insert;
  const maxMs = cfg.max_delay_to_insert > 0 ? cfg.max_delay_to_insert * 1000 : 1000;
  if (over >= allowed) return maxMs;
  return Math.max(cfg.min_delay_to_insert_ms, Math.trunc(maxMs * (over / allowed)));
}
