"""mirrors MergeTreeData::delayInsertOrThrowIfNeeded with the linear delay used since 23.1"""


def check_insert(parts_count, partition_bytes, cfg, total_parts=None):
    """None means TOO_MANY_PARTS, else the delay in ms; parts_count and partition_bytes are of the fullest partition"""
    if (parts_count if total_parts is None else total_parts) >= cfg.max_parts_in_total:
        return None
    average = partition_bytes // parts_count if parts_count else 0
    if cfg.max_avg_part_size_for_too_many_parts and average > cfg.max_avg_part_size_for_too_many_parts:
        return 0  # large parts disable both the delay and the rejection
    if parts_count >= cfg.parts_to_throw_insert:
        return None
    if not cfg.parts_to_delay_insert or parts_count < cfg.parts_to_delay_insert:
        return 0
    over = parts_count - cfg.parts_to_delay_insert + 1
    allowed = cfg.parts_to_throw_insert - cfg.parts_to_delay_insert
    max_ms = cfg.max_delay_to_insert * 1000 if cfg.max_delay_to_insert > 0 else 1000
    if over >= allowed:
        return max_ms
    return max(cfg.min_delay_to_insert_ms, int(max_ms * (over / allowed)))
