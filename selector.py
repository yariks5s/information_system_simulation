"""merge selection: SimpleMergeSelector port, the tiered baseline and the merge size limit"""
import math

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from inputs import MIB

# SimpleMergeSelector::Settings defaults that are not MergeTree settings
FIXED_COST = 5 * MIB  # size_fixed_cost_to_add
MIN_SIZE_TO_LOWER_BASE_LOG = math.log(1 + MIB)
MAX_SIZE_TO_LOWER_BASE_LOG = math.log(1 + 100 * 1024 * MIB)
AGE_TO_LOWER_BASE_AT_MIN_SIZE = (10, 3600)  # (min_age, max_age) in seconds
AGE_TO_LOWER_BASE_AT_MAX_SIZE = (10, 30 * 86400)
PARTS_TO_LOWER_BASE = (10, 50)
REMOVE_SMALL_AT_RIGHT_RATIO = 0.01
ALIGN_MIN_RATIO_TO_PREV = 0.9
ALIGN_MAX_POWERS_OF_TWO = 0.5
ALIGN_MAX_SCORE_ADJUSTMENT = 0.75
# CompactionStatistics: free space per source byte needed to select a merge, and reserved for it
SELECT_RATIO = 2.0  # DISK_USAGE_COEFFICIENT_TO_SELECT
RESERVE_RATIO = 1.1  # DISK_USAGE_COEFFICIENT_TO_RESERVE


def max_source_parts_bytes(max_tasks, scheduled, cfg, free_disk=None):
    """CompactionStatistics::getMaxSourcePartsBytesForMerge; free_disk None means no disk limit"""
    if cfg.max_bytes_at_max_space == 0:
        return 0
    free = max_tasks - scheduled
    if scheduled <= 1 or free >= cfg.free_entries_to_lower_max_size:
        limit = cfg.max_bytes_at_max_space
    else:
        low = max(1, min(cfg.max_bytes_at_min_space, cfg.max_bytes_at_max_space))
        limit = int(low * (cfg.max_bytes_at_max_space / low) ** (free / cfg.free_entries_to_lower_max_size))
    return limit if free_disk is None else min(limit, int(free_disk / SELECT_RATIO))


def _unit(value, low, high):  # mapPiecewiseLinearToUnit
    return 0.0 if value <= low else 1.0 if value >= high else (value - low) / (high - low)


def _lerp(low, high, ratio):  # interpolateLinear
    return low + (high - low) * ratio


def _allow(sum_size, max_size, min_age, count, range_size, base):
    size_normalized = _unit(math.log(1 + sum_size), MIN_SIZE_TO_LOWER_BASE_LOG, MAX_SIZE_TO_LOWER_BASE_LOG)
    min_age_to_lower = _lerp(AGE_TO_LOWER_BASE_AT_MIN_SIZE[0], AGE_TO_LOWER_BASE_AT_MAX_SIZE[0], size_normalized)
    max_age_to_lower = _lerp(AGE_TO_LOWER_BASE_AT_MIN_SIZE[1], AGE_TO_LOWER_BASE_AT_MAX_SIZE[1], size_normalized)
    age_normalized = _unit(min_age, min_age_to_lower, max_age_to_lower)
    # clickhouse passes the length of the free range here, not of the partition
    parts_normalized = _unit(range_size, *PARTS_TO_LOWER_BASE)
    lowered_base = _lerp(base, 2.0, min(1.0, age_normalized + parts_normalized))
    return (sum_size + count * FIXED_COST) / (max_size + FIXED_COST) >= lowered_base


def _score(segment, begin, end, sum_size):
    # the threshold uses the sum before removal, as in clickhouse
    threshold = REMOVE_SMALL_AT_RIGHT_RATIO * sum_size
    while end >= begin + 3 and segment[end - 1].size < threshold:
        end -= 1
        sum_size -= segment[end].size
    count = end - begin
    score = (sum_size + FIXED_COST * count) / (count - 1.9)
    prev = segment[begin - 1].size if begin else 0
    if prev > sum_size * ALIGN_MIN_RATIO_TO_PREV:
        difference = abs(math.log2(sum_size / prev))
        if difference < ALIGN_MAX_POWERS_OF_TWO:
            score *= _lerp(ALIGN_MAX_SCORE_ADJUSTMENT, 1, difference / ALIGN_MAX_POWERS_OF_TWO)
    return score, end


def _max_parts_to_merge(part_count, cfg):
    """the heuristic to lower max_parts_to_merge_at_once; 0 there means no limit"""
    limit = cfg.max_parts_to_merge_at_once
    if not limit:
        return math.inf
    if part_count < cfg.base:
        return limit
    if part_count >= cfg.parts_to_throw_insert:
        return min(limit, max(2, int(cfg.base)))
    fill = (part_count - cfg.base) / (cfg.parts_to_throw_insert - cfg.base)
    return min(limit, int(cfg.base + (limit - cfg.base) * (1 - fill**cfg.lower_max_parts_exponent)))


def _segments(parts):
    """runs of parts not being merged, as (offset, parts)"""
    start = 0
    for i, part in enumerate(parts + [None]):
        if part is None or part.merging:
            if i > start:
                yield start, parts[start:i]
            start = i + 1


def _segment_best(segment, offset, now, max_bytes, max_parts, cfg):
    """(score, -begin, begin, end), smaller is better so ties go to the right"""
    n = len(segment)
    best = None
    now = math.floor(now)  # ages are whole seconds, like time_t in clickhouse
    for begin in range(max(0, n - cfg.window_size), n):
        sum_size = max_size = segment[begin].size
        min_age = now - math.floor(segment[begin].created_at)
        for end in range(begin + 2, n + 1):
            if end - begin > max_parts:
                break
            part = segment[end - 1]
            sum_size += part.size
            max_size = max(max_size, part.size)
            min_age = min(min_age, now - math.floor(part.created_at))
            if sum_size > max_bytes:
                break
            if _allow(sum_size, max_size, min_age, end - begin, n, cfg.base):
                score, cut_end = _score(segment, begin, end, sum_size)
                candidate = (score, -(offset + begin), offset + begin, offset + cut_end)
                if best is None or candidate < best:
                    best = candidate
    return best


def _best(parts, now, max_bytes, cfg, segment_best):
    max_parts = _max_parts_to_merge(len(parts), cfg)  # counts parts being merged too
    best = None
    for offset, segment in _segments(parts):
        if len(segment) > 1:
            candidate = segment_best(segment, offset, now, max_bytes, max_parts, cfg)
            if candidate is not None and (best is None or candidate < best):
                best = candidate
    return best


def _select(parts, now, max_bytes, cfg, segment_best):
    best = _best(parts, now, max_bytes, cfg, segment_best)
    return None if best is None else best[2:]


def select_simple(parts, now, max_bytes, cfg):
    """SimpleMergeSelector::select with one constraint, as StorageMergeTree calls it"""
    return _select(parts, now, max_bytes, cfg, _segment_best)


def _segment_best_fast(segment, offset, now, max_bytes, max_parts, cfg):
    """_segment_best vectorized: rows are begins, columns are lengths - 1"""
    n = len(segment)
    first = max(0, n - cfg.window_size)
    sizes = np.fromiter((p.size for p in segment), dtype=np.int64, count=n)
    prefix = np.concatenate([[0], np.cumsum(sizes)])
    # sums grow with length, so no longer range fits into max_bytes
    fits = np.searchsorted(prefix, prefix[first : n - 1] + max_bytes, side="right") - 1 - np.arange(first, n - 1)
    width = int(min(max_parts, n - first, int(fits.max())))
    if width < 2:
        return None
    ages = math.floor(now) - np.floor(np.fromiter((p.created_at for p in segment), dtype=np.float64, count=n))
    window_sizes = sliding_window_view(np.concatenate([sizes, np.zeros(width - 1, dtype=np.int64)]), width)[first : n - 1]
    window_ages = sliding_window_view(np.concatenate([ages, np.full(width - 1, np.inf)]), width)[first : n - 1]
    sum_size = np.cumsum(window_sizes, axis=1)
    begin = np.arange(first, n - 1)[:, None]
    length = np.arange(1, width + 1)[None, :]
    rows, cols = np.nonzero((length >= 2) & (begin + length <= n) & (sum_size <= max_bytes))
    if not len(rows):
        return None
    begin, length, sum_size = rows + first, cols + 1, sum_size[rows, cols]
    max_size = np.maximum.accumulate(window_sizes, axis=1)[rows, cols]
    min_age = np.minimum.accumulate(window_ages, axis=1)[rows, cols]

    # _allow
    size_normalized = _unit_array(np.log(1 + sum_size.astype(np.float64)), MIN_SIZE_TO_LOWER_BASE_LOG, MAX_SIZE_TO_LOWER_BASE_LOG)
    min_age_to_lower = AGE_TO_LOWER_BASE_AT_MIN_SIZE[0] + (AGE_TO_LOWER_BASE_AT_MAX_SIZE[0] - AGE_TO_LOWER_BASE_AT_MIN_SIZE[0]) * size_normalized
    max_age_to_lower = AGE_TO_LOWER_BASE_AT_MIN_SIZE[1] + (AGE_TO_LOWER_BASE_AT_MAX_SIZE[1] - AGE_TO_LOWER_BASE_AT_MIN_SIZE[1]) * size_normalized
    age_normalized = _unit_array(min_age, min_age_to_lower, max_age_to_lower)
    lowered_base = cfg.base + (2.0 - cfg.base) * np.minimum(1.0, age_normalized + _unit(n, *PARTS_TO_LOWER_BASE))
    allowed = (sum_size + length * FIXED_COST) / (max_size + FIXED_COST) >= lowered_base
    if not allowed.any():
        return None
    b, end, total = begin[allowed], begin[allowed] + length[allowed], sum_size[allowed]

    # _score
    threshold = REMOVE_SMALL_AT_RIGHT_RATIO * total
    active = (end - b >= 3) & (sizes[end - 1] < threshold)
    while active.any():
        end = np.where(active, end - 1, end)
        active &= (end - b >= 3) & (sizes[end - 1] < threshold)
    total = prefix[end] - prefix[b]
    count = end - b
    score = (total + FIXED_COST * count) / (count - 1.9)
    prev = np.where(b > 0, sizes[np.maximum(b - 1, 0)], 0)
    aligned = prev > total * ALIGN_MIN_RATIO_TO_PREV
    with np.errstate(divide="ignore", invalid="ignore"):
        difference = np.abs(np.log2(total / np.where(aligned, prev, 1)))
    aligned &= difference < ALIGN_MAX_POWERS_OF_TWO
    adjustment = ALIGN_MAX_SCORE_ADJUSTMENT + (1 - ALIGN_MAX_SCORE_ADJUSTMENT) * (difference / ALIGN_MAX_POWERS_OF_TWO)
    score = np.where(aligned, score * adjustment, score)
    # smallest score, then the rightmost begin, then the shortest range
    i = np.lexsort((end, -b, score))[0]
    return (float(score[i]), -(offset + int(b[i])), offset + int(b[i]), offset + int(end[i]))


def _unit_array(value, low, high):
    return np.where(value <= low, 0.0, np.where(value >= high, 1.0, (value - low) / (high - low)))


# below this many candidates the python loop is faster than numpy
FAST_MIN_CANDIDATES = 200


def _segment_best_hybrid(segment, offset, now, max_bytes, max_parts, cfg):
    n = min(len(segment), cfg.window_size)
    fast = n * min(n, max_parts) >= FAST_MIN_CANDIDATES
    return (_segment_best_fast if fast else _segment_best)(segment, offset, now, max_bytes, max_parts, cfg)


def select_simple_fast(parts, now, max_bytes, cfg):
    """same choice as select_simple, test_fast_selector.py checks it"""
    return _select(parts, now, max_bytes, cfg, _segment_best_hybrid)


def select_tiered(parts, max_bytes, cfg):
    """baseline lsm tiering: the leftmost run of base idle same-level parts"""
    base = max(2, int(cfg.base))
    run = 0
    for i, part in enumerate(parts):
        if part.merging:
            run = 0
            continue
        run = run + 1 if run and part.level == parts[i - 1].level else 1
        if run >= base and sum(p.size for p in parts[i - base + 1 : i + 1]) <= max_bytes:
            return i - base + 1, i + 1
    return None


def select_across(partitions, now, max_bytes, cfg, selector):
    """(key, begin, end) or None; clickhouse breaks ties across partitions by address, here the later one wins"""
    if selector == "tiered":
        for key, parts in partitions.items():
            found = select_tiered(parts, max_bytes, cfg)
            if found:
                return (key, *found)
        return None
    segment_best = _segment_best if selector == "simple_reference" else _segment_best_hybrid
    best = None
    for key, parts in partitions.items():
        candidate = _best(parts, now, max_bytes, cfg, segment_best)
        if candidate is not None:
            candidate = (candidate[0], -key, *candidate[1:])
            if best is None or candidate < best:
                best = candidate
    return None if best is None else (-best[1], best[3], best[4])


SELECTORS = ("simple", "simple_reference", "tiered")
