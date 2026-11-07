"""MergeTreeBackgroundExecutor as rate allocation: one event per change of the task set, not one per step"""
from dataclasses import dataclass


@dataclass(eq=False)
class Task:
    id: int
    work: float  # thread-seconds
    priority: int  # source part bytes, the smallest go first under shortest_task_first
    payload: object = None
    remaining: float = 0.0
    rate: float = 0.0
    created_at: float = 0.0
    result_size: int = 0
    result_fresh: int = 0


class Pool:
    POLICIES = ("round_robin", "shortest_task_first")

    def __init__(self, engine, threads, max_tasks, policy, on_done):
        if policy not in self.POLICIES:
            raise ValueError(f"unknown scheduling policy {policy}")
        self.engine = engine
        self.threads = threads
        self.max_tasks = max_tasks
        self.policy = policy
        self.on_done = on_done
        self.tasks = []
        self._updated_at = 0.0
        self._token = 0  # completion events with an older token are stale

    def has_capacity(self):
        return len(self.tasks) < self.max_tasks

    def busy_threads(self):
        return sum(t.rate for t in self.tasks)

    def remaining_now(self, task):
        """without advancing the pool"""
        return task.remaining - task.rate * (self.engine.now - self._updated_at)

    def cancel_all(self):
        self._advance()
        tasks, self.tasks = self.tasks, []
        self._reallocate()
        return tasks

    def add(self, task):
        assert self.has_capacity()
        self._advance()
        task.remaining = task.work
        task.created_at = self.engine.now
        self.tasks.append(task)
        self._reallocate()

    def _advance(self):
        elapsed = self.engine.now - self._updated_at
        if elapsed > 0:
            for task in self.tasks:
                task.remaining -= task.rate * elapsed
        self._updated_at = self.engine.now

    def _reallocate(self):
        if self.policy == "round_robin":
            rate = min(1.0, self.threads / len(self.tasks)) if self.tasks else 0.0
            for task in self.tasks:
                task.rate = rate
        else:
            ranked = sorted(self.tasks, key=lambda t: (t.priority, t.id))
            for i, task in enumerate(ranked):
                task.rate = 1.0 if i < self.threads else 0.0
        self._token += 1
        running = [t for t in self.tasks if t.rate > 0]
        if running:
            first = min(running, key=lambda t: t.remaining / t.rate)
            self.engine.schedule(max(0.0, first.remaining / first.rate), self._on_complete, self._token, first)

    def _on_complete(self, token, task):
        if token != self._token:
            return
        self._advance()
        self.tasks.remove(task)
        self._reallocate()
        self.on_done(task)
