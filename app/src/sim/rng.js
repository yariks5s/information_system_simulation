// Seeded random streams. One stream per source of randomness, like the Python model (RFC section 4),
// so that changing one parameter does not shift the random numbers of the others.

const NV_MAGICCONST = 4 * Math.exp(-0.5) / Math.sqrt(2.0);

function hash(text) {
  // cyrb128: four 32-bit words from a string
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

export class Rng {
  constructor(seed) {
    [this.a, this.b, this.c, this.d] = hash(String(seed));
  }

  // sfc32, 53-bit doubles from two outputs
  next32() {
    let { a, b, c, d } = this;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }

  random() {
    return ((this.next32() >>> 5) * 67108864 + (this.next32() >>> 6)) / 9007199254740992;
  }

  // the same algorithms as Python's random module
  expovariate(lambd) {
    return -Math.log(1.0 - this.random()) / lambd;
  }

  normalvariate(mu, sigma) {
    for (;;) {
      const u1 = this.random();
      const u2 = 1.0 - this.random();
      const z = NV_MAGICCONST * (u1 - 0.5) / u2;
      if (z * z / 4.0 <= -Math.log(u2)) return mu + z * sigma;
    }
  }

  lognormvariate(mu, sigma) {
    return Math.exp(this.normalvariate(mu, sigma));
  }

  uniform(a, b) {
    return a + (b - a) * this.random();
  }
}

export function streams(seed, ...names) {
  const out = {};
  for (const name of names) out[name] = new Rng(`${seed}:${name}`);
  return out;
}

export function lognormal(rng, mean, cv) {
  // lognormal variate with the given mean and coefficient of variation
  if (cv === 0) return mean;
  const sigma2 = Math.log1p(cv * cv);
  return rng.lognormvariate(Math.log(mean) - sigma2 / 2, Math.sqrt(sigma2));
}

// Python's round(): half to even
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
