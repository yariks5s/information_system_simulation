// Merge selection (RFC 3.5, 3.6), a port of selector.py: SimpleMergeSelector with both heuristics, the
// pool-dependent merge size limit, and the baseline tiered selector. Besides the chosen range it returns why
// it was chosen, for the explanation panel of the UI.

const MIB = 1024 * 1024;
const FIXED_COST = 5 * MIB;  // size_fixed_cost_to_add
const MIN_SIZE_TO_LOWER_BASE_LOG = Math.log(1 + MIB);
const MAX_SIZE_TO_LOWER_BASE_LOG = Math.log(1 + 100 * 1024 * MIB);
const AGE_AT_MIN_SIZE = [10, 3600];  // (min_age, max_age) to lower base, seconds
const AGE_AT_MAX_SIZE = [10, 30 * 86400];
const PARTS_TO_LOWER_BASE = [10, 50];
const REMOVE_SMALL_AT_RIGHT_RATIO = 0.01;
const ALIGN_MIN_RATIO_TO_PREV = 0.9;
const ALIGN_MAX_POWERS_OF_TWO = 0.5;
const ALIGN_MAX_SCORE_ADJUSTMENT = 0.75;

// CompactionStatistics: a merge starts only with this much free space per source byte, and reserves RESERVE_RATIO
export const SELECT_RATIO = 2.0;  // DISK_USAGE_COEFFICIENT_TO_SELECT
export const RESERVE_RATIO = 1.1;  // DISK_USAGE_COEFFICIENT_TO_RESERVE

export function maxSourcePartsBytes(maxTasks, scheduled, cfg, freeDisk = null) {
  // CompactionStatistics::getMaxSourcePartsBytesForMerge; freeDisk is the free unreserved space, null for no limit
  if (cfg.max_bytes_at_max_space === 0) return 0;
  const free = maxTasks - scheduled;
  let limit;
  if (scheduled <= 1 || free >= cfg.free_entries_to_lower_max_size) limit = cfg.max_bytes_at_max_space;
  else {
    const low = Math.max(1, Math.min(cfg.max_bytes_at_min_space, cfg.max_bytes_at_max_space));
    limit = Math.trunc(low * Math.pow(cfg.max_bytes_at_max_space / low, free / cfg.free_entries_to_lower_max_size));
  }
  return freeDisk === null ? limit : Math.min(limit, Math.trunc(freeDisk / SELECT_RATIO));
}

const unit = (v, lo, hi) => (v <= lo ? 0.0 : v >= hi ? 1.0 : (v - lo) / (hi - lo));
const lerp = (lo, hi, r) => lo + (hi - lo) * r;

function loweredBase(sumSize, minAge, rangeSize, base) {
  const sizeNormalized = unit(Math.log(1 + sumSize), MIN_SIZE_TO_LOWER_BASE_LOG, MAX_SIZE_TO_LOWER_BASE_LOG);
  const minAgeToLower = lerp(AGE_AT_MIN_SIZE[0], AGE_AT_MAX_SIZE[0], sizeNormalized);
  const maxAgeToLower = lerp(AGE_AT_MIN_SIZE[1], AGE_AT_MAX_SIZE[1], sizeNormalized);
  const ageNormalized = unit(minAge, minAgeToLower, maxAgeToLower);
  // ClickHouse passes the size of the mergeable range here, not of the whole partition
  const partsNormalized = unit(rangeSize, PARTS_TO_LOWER_BASE[0], PARTS_TO_LOWER_BASE[1]);
  return lerp(base, 2.0, Math.min(1.0, ageNormalized + partsNormalized));
}

function score(segment, begin, end, sumSize) {
  // heuristic_to_remove_small_parts_at_right compares against the sum before removal
  const threshold = REMOVE_SMALL_AT_RIGHT_RATIO * sumSize;
  while (end >= begin + 3 && segment[end - 1].size < threshold) {
    end -= 1;
    sumSize -= segment[end].size;
  }
  const count = end - begin;
  let s = (sumSize + FIXED_COST * count) / (count - 1.9);
  const prev = begin ? segment[begin - 1].size : 0;
  let aligned = false;
  if (prev > sumSize * ALIGN_MIN_RATIO_TO_PREV) {
    const difference = Math.abs(Math.log2(sumSize / prev));
    if (difference < ALIGN_MAX_POWERS_OF_TWO) {
      s *= lerp(ALIGN_MAX_SCORE_ADJUSTMENT, 1, difference / ALIGN_MAX_POWERS_OF_TWO);
      aligned = true;
    }
  }
  return { score: s, end, sumSize, aligned };
}

export function maxPartsToMerge(partCount, cfg) {
  // merge_selector_enable_heuristic_to_lower_max_parts_to_merge_at_once
  const limit = cfg.max_parts_to_merge_at_once;
  if (partCount < cfg.base) return limit;
  if (partCount >= cfg.parts_to_throw_insert) return Math.max(2, Math.trunc(cfg.base));
  const fill = (partCount - cfg.base) / (cfg.parts_to_throw_insert - cfg.base);
  return Math.min(limit, Math.trunc(cfg.base + (limit - cfg.base) * (1 - Math.pow(fill, cfg.lower_max_parts_exponent))));
}

// smaller is better: score, then the rightmost partition, then the rightmost begin, then the shortest range
function better(a, b) {
  if (a.score !== b.score) return a.score < b.score;
  if (a.key !== b.key) return a.key > b.key;
  if (a.begin !== b.begin) return a.begin > b.begin;
  return a.end < b.end;
}

function segmentBest(segment, offset, key, now, maxBytes, maxParts, cfg, stats) {
  const n = segment.length;
  let best = null;
  for (let begin = Math.max(0, n - cfg.window_size); begin < n; begin++) {
    let sumSize = segment[begin].size, maxSize = sumSize, minAge = now - segment[begin].createdAt;
    for (let end = begin + 2; end <= n; end++) {
      if (end - begin > maxParts) break;
      const part = segment[end - 1];
      sumSize += part.size;
      if (part.size > maxSize) maxSize = part.size;
      const age = now - part.createdAt;
      if (age < minAge) minAge = age;
      if (sumSize > maxBytes) break;
      stats.considered++;
      const base = loweredBase(sumSize, minAge, n, cfg.base);  // n: the length of this run of free parts
      if ((sumSize + (end - begin) * FIXED_COST) / (maxSize + FIXED_COST) >= base) {
        stats.allowed++;
        const s = score(segment, begin, end, sumSize);
        const candidate = { key, score: s.score, begin: offset + begin, end: offset + s.end, sumSize: s.sumSize, count: s.end - begin,
                            maxSize, minAge, loweredBase: base, aligned: s.aligned, trimmed: end - s.end, segmentLength: n };
        if (best === null || better(candidate, best)) best = candidate;
      }
    }
  }
  return best;
}

function segments(parts) {
  // maximal runs of parts that are not being merged, as [offset, parts]
  const out = [];
  let start = 0;
  for (let i = 0; i <= parts.length; i++) {
    if (i === parts.length || parts[i].merging) {
      if (i > start) out.push([start, parts.slice(start, i)]);
      start = i + 1;
    }
  }
  return out;
}

function selectTieredIn(parts, maxBytes, cfg) {
  // baseline LSM tiering: the leftmost run of `base` adjacent idle parts of one level
  const base = Math.trunc(cfg.base);
  let run = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.merging) { run = 0; continue; }
    run = run && part.level === parts[i - 1].level ? run + 1 : 1;
    if (run >= base) {
      let sum = 0;
      for (let j = i - base + 1; j <= i; j++) sum += parts[j].size;
      if (sum <= maxBytes) return [i - base + 1, i + 1];
    }
  }
  return null;
}

// One merge over all partitions (a Map of key -> parts ordered by block, keys ascending).
// Returns { key, begin, end, ...explanation } or null, plus the counters in `stats`.
export function selectAcross(partitions, now, maxBytes, cfg, selector, stats = { considered: 0, allowed: 0 }) {
  if (selector === "tiered") {
    for (const [key, parts] of partitions) {
      const found = selectTieredIn(parts, maxBytes, cfg);
      if (found) {
        let sumSize = 0;
        for (let j = found[0]; j < found[1]; j++) sumSize += parts[j].size;
        return { key, begin: found[0], end: found[1], count: found[1] - found[0], sumSize, tiered: true };
      }
    }
    return null;
  }
  let best = null;
  for (const [key, parts] of partitions) {
    const maxParts = maxPartsToMerge(parts.length, cfg);  // counts parts being merged too
    for (const [offset, segment] of segments(parts)) {
      if (segment.length <= 1) continue;
      const candidate = segmentBest(segment, offset, key, now, maxBytes, maxParts, cfg, stats);
      if (candidate && (best === null || better(candidate, best))) best = { ...candidate, maxParts };
    }
  }
  return best;
}
