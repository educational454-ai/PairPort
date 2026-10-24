"""In-memory rate limiter for PairPort REST endpoints.

Provides a monotonic-clock sliding-window rate limiter per client IP.

ARCHITECTURE & SCALING NOTE:
This in-memory rate limiter is strictly per-process. It maintains state in Python
process memory and does not synchronize state across multiple worker processes or
distributed server instances. For multi-worker or clustered deployments, rate limiting
should be enforced at an upstream reverse proxy (e.g. Nginx, Caddy, Cloudflare)
or via a shared cache (e.g. Redis).
"""

from __future__ import annotations

import asyncio
import math
import time
from typing import Callable

from starlette.requests import Request

from app.config import (
    REST_RATE_LIMIT_CHECK_ROOM_PER_MIN,
    REST_RATE_LIMIT_CREATE_ROOM_PER_MIN,
    REST_RATE_LIMIT_MAX_ENTRIES,
    REST_RATE_LIMIT_WINDOW_SECONDS,
    TRUST_PROXY_HEADERS,
)


def get_client_ip(request: Request) -> str:
    """Extract direct client IP safely from request.

    Defaults to request.client.host. Does not trust X-Forwarded-For or
    similar headers unless PAIRPORT_TRUST_PROXY_HEADERS is explicitly enabled.
    Safely falls back to 'unknown' if client information is missing.
    """
    if TRUST_PROXY_HEADERS:
        x_forwarded_for = request.headers.get("x-forwarded-for")
        if x_forwarded_for:
            # First IP in X-Forwarded-For chain is the client
            client_ip = x_forwarded_for.split(",")[0].strip()
            if client_ip:
                return client_ip

    if request.client and request.client.host:
        return request.client.host
    return "unknown"


class InMemoryRateLimiter:
    """In-memory sliding-window rate limiter with monotonic clock and memory bounding."""

    def __init__(
        self,
        max_entries: int = REST_RATE_LIMIT_MAX_ENTRIES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_entries = max_entries
        self._clock = clock
        self._entries: dict[str, list[float]] = {}
        self._lock = asyncio.Lock()
        self._last_cleanup: float = 0.0

    async def acquire(
        self,
        key: str,
        limit: int,
        window_seconds: float,
    ) -> tuple[bool, int]:
        """Check if a request is permitted for the given key within the time window.

        Args:
            key: Rate limit bucket identifier (e.g., 'create:192.168.1.1').
            limit: Maximum requests allowed within window_seconds.
            window_seconds: Duration of the sliding window in seconds.

        Returns:
            (allowed: bool, retry_after: int)
            allowed is True if permitted, False if limit exceeded.
            retry_after is 0 if allowed, or the integer number of seconds
            until the earliest request expires and capacity frees up.
        """
        async with self._lock:
            now = self._clock()
            self._cleanup_stale_entries(now, window_seconds)

            timestamps = self._entries.get(key)
            if timestamps is None:
                # Guard against unbounded accumulation of distinct keys
                if len(self._entries) >= self._max_entries:
                    # Evict oldest entry in dict insertion order
                    oldest_key = next(iter(self._entries))
                    del self._entries[oldest_key]
                timestamps = []
                self._entries[key] = timestamps

            # Prune timestamps older than cutoff
            cutoff = now - window_seconds
            idx = 0
            while idx < len(timestamps) and timestamps[idx] <= cutoff:
                idx += 1
            if idx > 0:
                del timestamps[:idx]

            if len(timestamps) < limit:
                timestamps.append(now)
                return True, 0

            # Limit exceeded: determine when oldest request in current window rolls off
            oldest = timestamps[0]
            remaining = window_seconds - (now - oldest)
            retry_after = max(1, math.ceil(remaining))
            return False, retry_after

    def _cleanup_stale_entries(self, now: float, window_seconds: float) -> None:
        """Prune completely expired keys to bound memory footprint.

        Runs periodically or when entry count approaches capacity.
        """
        if now - self._last_cleanup < 10.0 and len(self._entries) < self._max_entries:
            return

        self._last_cleanup = now
        stale_keys = [
            k for k, ts in self._entries.items()
            if not ts or ts[-1] <= (now - window_seconds)
        ]
        for k in stale_keys:
            del self._entries[k]

    def reset(self) -> None:
        """Reset all rate limiter state (useful for test isolation)."""
        self._entries.clear()
        self._last_cleanup = 0.0


# Shared singleton rate limiter for REST room endpoints
rest_rate_limiter = InMemoryRateLimiter()
