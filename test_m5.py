"""M5 acceptance (RFC section 10): the fit recovers known parameters; auxiliary structures scale size and time."""
import math

import numpy as np

import calibrate
import stats
from inputs import MIB
from model import Config, simulate


def synthetic_merges(c0, c1, cv, n=4000, seed=1):
    rng = np.random.default_rng(seed)
    source_bytes = np.exp(rng.uniform(np.log(MIB), np.log(20 * 1024 * MIB), n))
    sigma2 = math.log1p(cv * cv)
    noise = rng.lognormal(-sigma2 / 2, math.sqrt(sigma2), n)  # mean 1
    duration = (c0 + c1 * source_bytes) * noise
    merges = np.zeros((n, 6))
    merges[:, 0], merges[:, 1], merges[:, 3] = duration, source_bytes, source_bytes
    return merges


def test_fit_recovers_known_parameters():
    fitted = calibrate.fit(synthetic_merges(c0=0.05, c1=1 / 250e6, cv=0.3))
    assert math.isclose(fitted["merge_fixed_seconds"], 0.05, rel_tol=0.1)
    assert math.isclose(fitted["merge_bytes_per_second"], 250e6, rel_tol=0.03)
    assert math.isclose(fitted["merge_noise_cv"], 0.3, rel_tol=0.05)
    assert abs(fitted["checks"]["residual_size_spearman"]) < 0.05


def test_aux_structures_scale_sizes_and_merge_time():
    plain = simulate(Config(insert_rate=1), 4 * 3600)
    aux = simulate(Config(insert_rate=1, aux=((1.0, 1.0),)), 4 * 3600)
    # the same size stream, doubled on disk (each insert rounds once)
    assert abs(aux.inserted_bytes - 2 * plain.inserted_bytes) <= aux.last_block
    ratio = stats.summary(aux, 3600)["merge_duration_mean"] / stats.summary(plain, 3600)["merge_duration_mean"]
    assert 1.6 < ratio < 2.4, ratio


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
