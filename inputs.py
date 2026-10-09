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


def daily_rate(mean, amplitude, peak_at, burst):
    """Rate λ(t) with a daily cosine profile and an optional (start, duration, factor) burst,
    and its maximum, for thinning."""
    def rate(t):
        value = mean * (1 + amplitude * math.cos(2 * math.pi * (t - peak_at) / DAY))
        if burst and burst[0] <= t < burst[0] + burst[1]:
            value *= burst[2]
        return value

    return rate, mean * (1 + amplitude) * max(1.0, burst[2] if burst else 1.0)


def next_arrival(t, rate, peak, candidates, thinning):
    """Next event of a non-homogeneous Poisson process after t, by thinning (Lewis, Shedler)."""
    while True:
        t += candidates.expovariate(peak)
        if thinning.random() * peak <= rate(t):
            return t
