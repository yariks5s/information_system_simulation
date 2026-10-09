// Background merges and mutations executor (RFC 3.4) as a rate-allocation queue.
// round_robin shares the threads equally among all tasks (processor sharing); shortest_task_first gives the
// threads to the tasks with the smallest priority, the sum of source part bytes. One event per change of the task set.

export const POLICIES = ["round_robin", "shortest_task_first"];

export class Pool {
  constructor(engine, threads, maxTasks, policy, onDone) {
    if (!POLICIES.includes(policy)) throw new Error(`unknown scheduling policy ${policy}`);
    this.engine = engine;
    this.threads = threads;
    this.maxTasks = maxTasks;
    this.policy = policy;
    this.onDone = onDone;
    this.tasks = [];
    this.updatedAt = 0;
    this.token = 0;
  }

  hasCapacity() {
    return this.tasks.length < this.maxTasks;
  }

  busyThreads() {
    let s = 0;
    for (const t of this.tasks) s += t.rate;
    return s;
  }

  add(task) {
    if (!this.hasCapacity()) throw new Error("pool is full");
    this.advance();
    task.remaining = task.work;
    task.createdAt = this.engine.now;
    this.tasks.push(task);
    this.reallocate();
  }

  // live changes from the UI
  configure({ threads, maxTasks, policy }) {
    this.advance();
    if (threads != null) this.threads = threads;
    if (maxTasks != null) this.maxTasks = maxTasks;
    if (policy != null) {
      if (!POLICIES.includes(policy)) throw new Error(`unknown scheduling policy ${policy}`);
      this.policy = policy;
    }
    this.reallocate();
  }

  advance() {
    const elapsed = this.engine.now - this.updatedAt;
    if (elapsed > 0) for (const t of this.tasks) t.remaining -= t.rate * elapsed;
    this.updatedAt = this.engine.now;
  }

  // remaining work of a task at the current model time, without advancing the pool
  remainingNow(task) {
    return task.remaining - task.rate * (this.engine.now - this.updatedAt);
  }

  reallocate() {
    if (this.policy === "round_robin") {
      const rate = this.tasks.length ? Math.min(1.0, this.threads / this.tasks.length) : 0.0;
      for (const t of this.tasks) t.rate = rate;
    } else {
      const ranked = this.tasks.slice().sort((a, b) => a.priority - b.priority || a.id - b.id);
      ranked.forEach((t, i) => { t.rate = i < this.threads ? 1.0 : 0.0; });
    }
    this.token++;
    let first = null;
    for (const t of this.tasks) {
      if (t.rate > 0 && (first === null || t.remaining / t.rate < first.remaining / first.rate)) first = t;
    }
    if (first) this.engine.schedule(Math.max(0.0, first.remaining / first.rate), (token, task) => this.complete(token, task), this.token, first);
  }

  complete(token, task) {
    if (token !== this.token) return;
    this.advance();
    this.tasks.splice(this.tasks.indexOf(task), 1);
    this.reallocate();
    this.onDone(task);
  }
}
