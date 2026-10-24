"""Unit tests for the in-memory REST rate limiter and IP resolution."""

import asyncio
import unittest
from unittest.mock import MagicMock, patch

from starlette.requests import Request

from app.services.rate_limiter import InMemoryRateLimiter, get_client_ip


class FakeClock:
    """Deterministic monotonic clock for rate limiter unit testing."""

    def __init__(self, initial_time: float = 1000.0) -> None:
        self.current_time = initial_time

    def __call__(self) -> float:
        return self.current_time

    def advance(self, seconds: float) -> None:
        self.current_time += seconds


class TestInMemoryRateLimiter(unittest.IsolatedAsyncioTestCase):

    def setUp(self) -> None:
        self.clock = FakeClock(1000.0)
        self.limiter = InMemoryRateLimiter(max_entries=10, clock=self.clock)

    async def test_requests_below_limit_succeed(self) -> None:
        """Verify requests under the limit succeed with retry_after=0."""
        for _ in range(5):
            allowed, retry_after = await self.limiter.acquire("client_a", limit=5, window_seconds=60.0)
            self.assertTrue(allowed)
            self.assertEqual(retry_after, 0)

    async def test_request_beyond_limit_returns_429_retry_after(self) -> None:
        """Verify the first request beyond the limit returns allowed=False and positive retry_after."""
        # 5 allowed
        for _ in range(5):
            await self.limiter.acquire("client_a", limit=5, window_seconds=60.0)

        # 6th request: rejected
        allowed, retry_after = await self.limiter.acquire("client_a", limit=5, window_seconds=60.0)
        self.assertFalse(allowed)
        self.assertEqual(retry_after, 60)

        # Advance clock by 25.5 seconds: retry_after should be ceil(60 - 25.5) = 35
        self.clock.advance(25.5)
        allowed, retry_after = await self.limiter.acquire("client_a", limit=5, window_seconds=60.0)
        self.assertFalse(allowed)
        self.assertEqual(retry_after, 35)

    async def test_deterministic_window_rolloff(self) -> None:
        """Verify that when window passes, new requests succeed without real sleep."""
        # Request at t=1000.0
        await self.limiter.acquire("client_a", limit=1, window_seconds=60.0)

        # Immediate follow-up: rejected
        allowed, _ = await self.limiter.acquire("client_a", limit=1, window_seconds=60.0)
        self.assertFalse(allowed)

        # Advance past 60.0s window: t=1060.1
        self.clock.advance(60.1)
        allowed, retry_after = await self.limiter.acquire("client_a", limit=1, window_seconds=60.0)
        self.assertTrue(allowed)
        self.assertEqual(retry_after, 0)

    async def test_isolation_by_client_key(self) -> None:
        """Verify rate limits are strictly isolated by client key (IP)."""
        # Exhaust client_a
        for _ in range(3):
            await self.limiter.acquire("client_a", limit=3, window_seconds=60.0)
        allowed_a, _ = await self.limiter.acquire("client_a", limit=3, window_seconds=60.0)
        self.assertFalse(allowed_a)

        # client_b is untouched and should succeed
        allowed_b, retry_b = await self.limiter.acquire("client_b", limit=3, window_seconds=60.0)
        self.assertTrue(allowed_b)
        self.assertEqual(retry_b, 0)

    async def test_concurrency_race_condition_protection(self) -> None:
        """Verify that concurrent tasks cannot race past the configured limit."""
        limit = 5
        window = 60.0

        async def worker() -> bool:
            allowed, _ = await self.limiter.acquire("race_client", limit=limit, window_seconds=window)
            return allowed

        # Launch 25 concurrent acquire calls
        tasks = [worker() for _ in range(25)]
        results = await asyncio.gather(*tasks)

        allowed_count = sum(1 for r in results if r)
        rejected_count = sum(1 for r in results if not r)
        self.assertEqual(allowed_count, limit)
        self.assertEqual(rejected_count, 20)

    async def test_bounded_memory_capacity_eviction(self) -> None:
        """Verify memory is bounded and evicts oldest entries when max_entries is exceeded."""
        small_limiter = InMemoryRateLimiter(max_entries=3, clock=self.clock)

        await small_limiter.acquire("ip_1", limit=10, window_seconds=60.0)
        await small_limiter.acquire("ip_2", limit=10, window_seconds=60.0)
        await small_limiter.acquire("ip_3", limit=10, window_seconds=60.0)
        self.assertEqual(len(small_limiter._entries), 3)

        # Adding a 4th key should evict the oldest key (ip_1)
        await small_limiter.acquire("ip_4", limit=10, window_seconds=60.0)
        self.assertLessEqual(len(small_limiter._entries), 3)
        self.assertNotIn("ip_1", small_limiter._entries)
        self.assertIn("ip_4", small_limiter._entries)

    async def test_stale_entry_cleanup(self) -> None:
        """Verify expired entries are purged during periodic cleanup."""
        await self.limiter.acquire("stale_ip", limit=10, window_seconds=10.0)
        self.assertIn("stale_ip", self.limiter._entries)

        # Advance time past window and past cleanup throttle interval (10s)
        self.clock.advance(15.0)

        # Next acquire on another key triggers stale entry purge
        await self.limiter.acquire("fresh_ip", limit=10, window_seconds=10.0)
        self.assertNotIn("stale_ip", self.limiter._entries)
        self.assertIn("fresh_ip", self.limiter._entries)


class TestClientIPResolution(unittest.TestCase):

    def test_extract_direct_client_ip(self) -> None:
        """Verify request.client.host is used by default."""
        request = MagicMock(spec=Request)
        request.client = MagicMock(host="192.168.1.100")
        request.headers = {"x-forwarded-for": "10.0.0.1"}

        with patch("app.services.rate_limiter.TRUST_PROXY_HEADERS", False):
            ip = get_client_ip(request)
            self.assertEqual(ip, "192.168.1.100")

    def test_missing_client_address_handled_safely(self) -> None:
        """Verify missing or None request.client returns 'unknown' without error."""
        request = MagicMock(spec=Request)
        request.client = None
        request.headers = {}

        ip = get_client_ip(request)
        self.assertEqual(ip, "unknown")

    def test_trusted_proxy_header_resolution(self) -> None:
        """Verify X-Forwarded-For is respected only when TRUST_PROXY_HEADERS is enabled."""
        request = MagicMock(spec=Request)
        request.client = MagicMock(host="127.0.0.1")
        request.headers = {"x-forwarded-for": "203.0.113.195, 70.41.3.18"}

        with patch("app.services.rate_limiter.TRUST_PROXY_HEADERS", True):
            ip = get_client_ip(request)
            self.assertEqual(ip, "203.0.113.195")


if __name__ == "__main__":
    unittest.main()
