"""In-memory rate limiting (single server). Use a shared store such as Redis
when running more than one instance."""

from __future__ import annotations

import time
from collections import defaultdict, deque


class SlidingWindowLimiter:
    """Allows at most `limit` events per `window_seconds` for each key."""

    def __init__(self, limit: int, window_seconds: float, clock=time.monotonic):
        self.limit = limit
        self.window = window_seconds
        self.clock = clock
        self.events: dict[str, deque[float]] = defaultdict(deque)

    def _trim(self, key: str) -> deque[float]:
        q = self.events[key]
        cutoff = self.clock() - self.window
        while q and q[0] <= cutoff:
            q.popleft()
        return q

    def allowed(self, key: str) -> bool:
        return len(self._trim(key)) < self.limit

    def hit(self, key: str) -> None:
        self._trim(key).append(self.clock())
        if len(self.events) > 10000:
            for k in [k for k, q in self.events.items() if not q]:
                del self.events[k]

    def retry_after(self, key: str) -> int:
        q = self._trim(key)
        return int(q[0] + self.window - self.clock()) + 1 if q else 0

    def reset(self, key: str) -> None:
        self.events.pop(key, None)
