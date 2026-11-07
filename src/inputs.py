"""one stream per source of randomness, so changing one factor leaves the others' numbers alone"""
import math
import random

MIB = 1024 * 1024
DAY = 86400.0


def streams(seed, *names):
    # str seeds go through sha512, not hash(), so runs are reproducible
    return {name: random.Random(f"{seed}:{name}") for name in names}


def lognormal(rng, mean, cv):
    """mean and cv are of the variate itself, not of the underlying normal"""
    if cv == 0:
        return mean
    sigma2 = math.log1p(cv * cv)
    return rng.lognormvariate(math.log(mean) - sigma2 / 2, math.sqrt(sigma2))


def daily_rate(mean, amplitude, peak_at):
    """rate(t) and its maximum, the bound for thinning"""
    def rate(t):
        return mean * (1 + amplitude * math.cos(2 * math.pi * (t - peak_at) / DAY))

    return rate, mean * (1 + amplitude)


def burst_rate(rate, peak, burst):
    """extra rate of a burst as its own process, so base arrivals are the same with and without it"""
    start, duration, factor = burst

    def extra(t):
        return (factor - 1) * rate(t) if start <= t < start + duration else 0.0

    return extra, (factor - 1) * peak


def next_arrival(t, rate, peak, candidates, thinning, until=math.inf):
    """thinning as in Lewis-Shedler; None when nothing arrives before until"""
    while True:
        t += candidates.expovariate(peak)
        if t >= until:
            return None
        if thinning.random() * peak <= rate(t):
            return t
