import heapq
import itertools
import math


class Engine:
    def __init__(self):
        self.now = 0.0
        self.events = 0
        self._calendar = []
        self._seq = itertools.count()  # equal times fire in scheduling order

    def schedule(self, delay, handler, *args):
        if delay < 0:
            raise ValueError(f"negative delay {delay}")
        heapq.heappush(self._calendar, (self.now + delay, next(self._seq), handler, args))

    def run(self, until=math.inf, max_events=math.inf, after_event=None):
        stop = self.events + max_events
        while self._calendar and self._calendar[0][0] <= until and self.events < stop:
            time, _, handler, args = heapq.heappop(self._calendar)
            assert time >= self.now
            self.now = time
            handler(*args)
            self.events += 1
            if after_event:
                after_event()
        if self.events < stop and until < math.inf:
            self.now = until
