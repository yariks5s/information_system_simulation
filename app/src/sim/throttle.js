// Insert throttling (RFC 3.3): MergeTreeData::delayInsertOrThrowIfNeeded. The delay grows linearly with the
// number of parts over parts_to_delay_insert; the doc string of max_delay_to_insert still shows an older formula.

// Returns null if the insert is rejected with TOO_MANY_PARTS, otherwise its delay in milliseconds.
// partsCount and partitionBytes are of the partition with the most parts; totalParts counts all partitions.
export function checkInsert(partsCount, partitionBytes, cfg, totalParts = partsCount) {
  if (totalParts >= cfg.max_parts_in_total) return null;
  const average = partsCount ? Math.floor(partitionBytes / partsCount) : 0;
  if (cfg.max_avg_part_size_for_too_many_parts && average > cfg.max_avg_part_size_for_too_many_parts) return 0;
  if (partsCount >= cfg.parts_to_throw_insert) return null;
  if (!cfg.parts_to_delay_insert || partsCount < cfg.parts_to_delay_insert) return 0;
  const over = partsCount - cfg.parts_to_delay_insert + 1;
  const allowed = cfg.parts_to_throw_insert - cfg.parts_to_delay_insert;
  const maxMs = cfg.max_delay_to_insert > 0 ? cfg.max_delay_to_insert * 1000 : 1000;
  if (over >= allowed) return maxMs;
  return Math.max(cfg.min_delay_to_insert_ms, Math.trunc(maxMs * over / allowed));
}
