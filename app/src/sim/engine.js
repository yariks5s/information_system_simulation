export class Engine {
  constructor() {
    this.now = 0;
    this.events = 0;
    this.heap = [];
    this.seq = 0;
  }

  schedule(delay, handler, ...args) {
    if (delay < 0) throw new Error(`negative delay ${delay}`);
    const item = { time: this.now + delay, seq: this.seq++, handler, args };
    const h = this.heap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  peekTime() {
    return this.heap.length ? this.heap[0].time : Infinity;
  }

  pop() {
    const h = this.heap, top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && less(h[l], h[m])) m = l;
        if (r < h.length && less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }

  step() {
    if (!this.heap.length) return false;
    const item = this.pop();
    if (item.time < this.now) throw new Error("time went backwards");
    this.now = item.time;
    item.handler(...item.args);
    this.events++;
    return true;
  }

  run(until = Infinity, maxEvents = Infinity, afterEvent = null) {
    const stop = this.events + maxEvents;
    while (this.heap.length && this.heap[0].time <= until && this.events < stop) {
      this.step();
      if (afterEvent) afterEvent();
    }
    if (this.events < stop && until < Infinity && until > this.now) this.now = until;
  }
}

// seq breaks ties, so equal-time events fire in scheduling order like heapq in engine.py
function less(a, b) {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}
