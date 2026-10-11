"""Random inputs. One generator per source of randomness, so that changing one factor
does not shift the random numbers of the others (common random numbers, RFC section 4)."""
import math
import random

MIB = 1024 * 1024
DAY = 86400.0


def streams(seed, *names):
    # str seeds are hashed with sha512, so streams are reproducible across runs
    return {name: random.Random(f"{seed}:{name}") for name in names}


def lognormal(rng, mean, cv):
    """Lognormal variate with the given mean and coefficient of variation."""
    if cv == 0:
        return mean
    sigma2 = math.log1p(cv * cv)
    return rng.lognormvariate(math.log(mean) - sigma2 / 2, math.sqrt(sigma2))


def daily_rate(mean, amplitude, peak_at):
    """Rate λ(t) with a daily cosine profile, and its maximum, for thinning."""
    def rate(t):
        return mean * (1 + amplitude * math.cos(2 * math.pi * (t - peak_at) / DAY))

    return rate, mean * (1 + amplitude)


def burst_rate(rate, peak, burst):
    """Extra rate (factor - 1) λ(t) of a (start, duration, factor) burst, and its maximum. The model adds it as a
    separate Poisson process with its own streams, so the base arrivals are the same with and without the burst."""
    start, duration, factor = burst

    def extra(t):
        return (factor - 1) * rate(t) if start <= t < start + duration else 0.0

    return extra, (factor - 1) * peak


def next_arrival(t, rate, peak, candidates, thinning, until=math.inf):
    """Next event of a non-homogeneous Poisson process after t, by thinning (Lewis, Shedler); None if not before until."""
    while True:
        t += candidates.expovariate(peak)
        if t >= until:
            return None
        if thinning.random() * peak <= rate(t):
            return t
