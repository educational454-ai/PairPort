"""Deterministic integration and unit tests for WebSocket IP rate limiting and legacy token hardening (Step 9H-1).

Validates:
1. Multiple WebSocket connections from the same client IP share the rate-limit budget.
2. Reconnecting does not reset the budget.
3. The normal /ws join path is rate-limited before room_manager.join_room is called.
4. Room creation is rate-limited before room_manager.create_room is called.
5. Every path-based join attempt is rate-limited or explicitly rejected (query param prohibited / invitation required).
6. Invalid and missing invitation tokens consume attempt capacity.
7. A valid invitation remains usable after an earlier invalid attempt if budget remains.
8. Rate-limit structured responses, retry_after values, and close codes (1008).
9. Client-IP and TRUST_PROXY_HEADERS compliance.
10. WebRTC signaling traffic is NOT throttled by join/create rate limits.
11. Window expiration frees capacity deterministically using fake clocks.
"""

from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import (
    WS_RATE_LIMIT_CREATE_PER_MIN,
    WS_RATE_LIMIT_JOIN_PER_MIN,
    WS_RATE_LIMIT_WINDOW_SECONDS,
)
from app.main import app
from app.services.rate_limiter import InMemoryRateLimiter, get_client_ip, ws_rate_limiter
from app.services.room_manager import room_manager


class TestWebSocketRateLimiting(unittest.TestCase):
    """Test suite for process-wide shared IP WebSocket rate limiting."""

    def setUp(self) -> None:
        self.client = TestClient(app, headers={"origin": "http://localhost:5173"})
        room_manager.rooms.clear()
        ws_rate_limiter.reset()

    def tearDown(self) -> None:
        room_manager.rooms.clear()
        ws_rate_limiter.reset()

    def test_multiple_connections_from_same_ip_share_create_budget(self) -> None:
        """Verify multiple WebSocket connections from the same IP share the create rate limit budget."""
        # WS_RATE_LIMIT_CREATE_PER_MIN rooms allowed per window (default 10)
        for i in range(WS_RATE_LIMIT_CREATE_PER_MIN):
            with self.client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "create"})
                msg = ws.receive_json()
                self.assertEqual(msg["type"], "room-created", f"Create attempt {i+1} should succeed")

        # 11th create attempt on a fresh connection from the same IP must be rejected
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "create"})
            msg = ws.receive_json()
            self.assertEqual(msg["type"], "error")
            self.assertEqual(msg["payload"]["code"], "RATE_LIMITED")
            self.assertIn("retry_after", msg["payload"])
            self.assertGreater(msg["payload"]["retry_after"], 0)

    def test_reconnecting_does_not_reset_join_budget(self) -> None:
        """Verify closing a socket and reconnecting on a fresh socket does not reset the join budget."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            valid_token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()  # waiting

            # Consume all join attempts across individual connections
            for i in range(WS_RATE_LIMIT_JOIN_PER_MIN):
                with self.client.websocket_connect("/ws") as guest_ws:
                    guest_ws.send_json({
                        "type": "join",
                        "payload": {
                            "room_code": room_code,
                            "invitation_token": "invalid-token-guess",
                        },
                    })
                    msg = guest_ws.receive_json()
                    # Should fail due to invalid token, not rate limit yet
                    self.assertEqual(msg["payload"]["code"], "INVALID_INVITATION")

            # Reconnect on a brand new socket and try to join with the VALID token
            with self.client.websocket_connect("/ws") as fresh_ws:
                fresh_ws.send_json({
                    "type": "join",
                    "payload": {
                        "room_code": room_code,
                        "invitation_token": valid_token,
                    },
                })
                msg = fresh_ws.receive_json()
                # Must be RATE_LIMITED despite having the valid token and a brand new connection
                self.assertEqual(msg["type"], "error")
                self.assertEqual(msg["payload"]["code"], "RATE_LIMITED")
                self.assertIn("retry_after", msg["payload"])

    def test_join_is_limited_before_room_manager_join_room(self) -> None:
        """Verify normal /ws join is checked and blocked before room_manager.join_room is called."""
        # Exhaust join budget directly
        for _ in range(WS_RATE_LIMIT_JOIN_PER_MIN):
            with self.client.websocket_connect("/ws") as ws:
                ws.send_json({
                    "type": "join",
                    "payload": {"room_code": "PORT-NONEXISTENT", "invitation_token": "xyz"},
                })
                _ = ws.receive_json()

        with patch.object(room_manager, "join_room", new_callable=AsyncMock) as mock_join:
            with self.client.websocket_connect("/ws") as ws:
                ws.send_json({
                    "type": "join",
                    "payload": {"room_code": "PORT-TEST12", "invitation_token": "any"},
                })
                msg = ws.receive_json()
                self.assertEqual(msg["type"], "error")
                self.assertEqual(msg["payload"]["code"], "RATE_LIMITED")
                # Ensure room_manager.join_room was never reached
                mock_join.assert_not_called()

    def test_create_is_limited_before_room_manager_create_room(self) -> None:
        """Verify room creation is checked and blocked before room_manager.create_room is called."""
        for _ in range(WS_RATE_LIMIT_CREATE_PER_MIN):
            with self.client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "create"})
                _ = ws.receive_json()

        with patch.object(room_manager, "create_room", new_callable=AsyncMock) as mock_create:
            with self.client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "create"})
                msg = ws.receive_json()
                self.assertEqual(msg["type"], "error")
                self.assertEqual(msg["payload"]["code"], "RATE_LIMITED")
                mock_create.assert_not_called()

    def test_path_based_joins_reject_query_parameter_tokens(self) -> None:
        """Verify /ws/{room_code} explicitly prohibits query parameter invitation tokens."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]

        # Various query parameter names attempting to pass a secret
        test_query_params = [
            f"/ws/{room_code}?invitation_token={token}",
            f"/ws/{room_code}?token={token}",
            f"/ws/{room_code}?invite={token}",
            f"/ws/{room_code}?secret={token}",
            f"/ws/{room_code}?key={token}",
        ]
        for url in test_query_params:
            with self.assertRaises(WebSocketDisconnect) as cm:
                with self.client.websocket_connect(url) as guest_ws:
                    err = guest_ws.receive_json()
                    self.assertEqual(err["type"], "error")
                    self.assertEqual(err["payload"]["code"], "QUERY_PARAM_TOKEN_PROHIBITED")
                    guest_ws.receive_json()
            self.assertEqual(cm.exception.code, 1008)

    def test_path_based_joins_without_token_reject_with_invitation_required(self) -> None:
        """Verify /ws/{room_code} without query parameter is rejected with INVITATION_REQUIRED."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            room_code = host_ws.receive_json()["payload"]["room_code"]

        with self.assertRaises(WebSocketDisconnect) as cm:
            with self.client.websocket_connect(f"/ws/{room_code}") as guest_ws:
                err = guest_ws.receive_json()
                self.assertEqual(err["type"], "error")
                self.assertEqual(err["payload"]["code"], "INVITATION_REQUIRED")
                guest_ws.receive_json()
        self.assertEqual(cm.exception.code, 1008)

    def test_path_based_join_attempts_consume_rate_limit_and_throttle(self) -> None:
        """Verify path-based join attempts consume the join budget and get throttled."""
        for _ in range(WS_RATE_LIMIT_JOIN_PER_MIN):
            with self.client.websocket_connect("/ws/PORT-TEST01") as ws:
                _ = ws.receive_json()

        # The 31st path-based join attempt must be closed with RATE_LIMITED error and close code 1008
        with self.assertRaises(WebSocketDisconnect) as cm:
            with self.client.websocket_connect("/ws/PORT-TEST01") as ws:
                err = ws.receive_json()
                self.assertEqual(err["type"], "error")
                self.assertEqual(err["payload"]["code"], "RATE_LIMITED")
                self.assertIn("retry_after", err["payload"])
                ws.receive_json()
        self.assertEqual(cm.exception.code, 1008)

    def test_invalid_and_missing_invitation_tokens_consume_capacity(self) -> None:
        """Verify malformed, missing, and non-existent room join attempts consume budget."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()  # waiting

            with self.client.websocket_connect("/ws") as guest_ws:
                # 1. Missing room_code
                guest_ws.send_json({"type": "join", "payload": {}})
                err = guest_ws.receive_json()
                self.assertEqual(err["payload"]["code"], "MISSING_ROOM_CODE")

                # 2. Non-existent room
                guest_ws.send_json({"type": "join", "payload": {"room_code": "PORT-999999"}})
                err = guest_ws.receive_json()
                self.assertEqual(err["payload"]["code"], "ROOM_NOT_FOUND")

                # 3. Missing invitation token
                guest_ws.send_json({"type": "join", "payload": {"room_code": room_code}})
                err = guest_ws.receive_json()
                self.assertEqual(err["payload"]["code"], "INVITATION_REQUIRED")

                # 4. Wrong invitation token
                guest_ws.send_json({"type": "join", "payload": {"room_code": room_code, "invitation_token": "wrong"}})
                err = guest_ws.receive_json()
                self.assertEqual(err["payload"]["code"], "INVALID_INVITATION")

            # That consumed 4 attempts. Now exhaust remaining (WS_RATE_LIMIT_JOIN_PER_MIN - 4) attempts
            remaining = WS_RATE_LIMIT_JOIN_PER_MIN - 4
            for _ in range(remaining):
                with self.client.websocket_connect("/ws") as ws:
                    ws.send_json({"type": "join", "payload": {"room_code": room_code, "invitation_token": "bad"}})
                    _ = ws.receive_json()

            # Next attempt must be throttled
            with self.client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "join", "payload": {"room_code": room_code, "invitation_token": token}})
                err = ws.receive_json()
                self.assertEqual(err["payload"]["code"], "RATE_LIMITED")

    def test_valid_invitation_usable_after_earlier_invalid_attempt_if_budget_remains(self) -> None:
        """Verify a user who makes a typo in their token can still join if budget remains."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()  # waiting

            with self.client.websocket_connect("/ws") as guest_ws:
                # 1. Mistyped token
                guest_ws.send_json({
                    "type": "join",
                    "payload": {
                        "room_code": room_code,
                        "invitation_token": "typo-in-token",
                    },
                })
                err = guest_ws.receive_json()
                self.assertEqual(err["payload"]["code"], "INVALID_INVITATION")

                # 2. Correct token immediately on the same socket
                guest_ws.send_json({
                    "type": "join",
                    "payload": {
                        "room_code": room_code,
                        "invitation_token": token,
                    },
                })
                success = guest_ws.receive_json()
                self.assertEqual(success["type"], "peer-joined")
                self.assertEqual(success["payload"]["role"], "guest")

    def test_signaling_traffic_not_throttled_by_join_budget(self) -> None:
        """Verify peer-to-peer signaling relays (offer, answer, candidate) are NOT throttled by join limits."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()  # waiting

            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code, "invitation_token": token},
                })
                _ = guest_ws.receive_json()  # guest peer-joined
                _ = host_ws.receive_json()   # host peer-joined

                # Exhaust the join budget completely using separate connections
                for _ in range(WS_RATE_LIMIT_JOIN_PER_MIN):
                    with self.client.websocket_connect("/ws") as dummy_ws:
                        dummy_ws.send_json({
                            "type": "join",
                            "payload": {"room_code": "PORT-999999", "invitation_token": "x"},
                        })
                        _ = dummy_ws.receive_json()

                # Confirm join budget is now exhausted
                with self.client.websocket_connect("/ws") as dummy_ws:
                    dummy_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": "PORT-999999", "invitation_token": "x"},
                    })
                    err = dummy_ws.receive_json()
                    self.assertEqual(err["payload"]["code"], "RATE_LIMITED")

                # Despite join budget exhaustion, existing session can freely exchange WebRTC signaling!
                # 1. Offer
                host_ws.send_json({
                    "type": "signal-offer",
                    "payload": {"sdp": {"type": "offer", "sdp": "v=0\r\no=alice..."}},
                })
                offer_relayed = guest_ws.receive_json()
                self.assertEqual(offer_relayed["type"], "signal-offer")
                self.assertEqual(offer_relayed["payload"]["sdp"]["type"], "offer")

                # 2. Answer
                guest_ws.send_json({
                    "type": "signal-answer",
                    "payload": {"sdp": {"type": "answer", "sdp": "v=0\r\no=bob..."}},
                })
                answer_relayed = host_ws.receive_json()
                self.assertEqual(answer_relayed["type"], "signal-answer")
                self.assertEqual(answer_relayed["payload"]["sdp"]["type"], "answer")

                # 3. Candidate
                host_ws.send_json({
                    "type": "signal-candidate",
                    "payload": {"candidate": {"candidate": "candidate:1 1 UDP 1 127.0.0.1 5000 typ host"}},
                })
                cand_relayed = guest_ws.receive_json()
                self.assertEqual(cand_relayed["type"], "signal-candidate")

    def test_trusted_proxy_headers_and_client_ip_resolution(self) -> None:
        """Verify client IP extraction adheres to TRUST_PROXY_HEADERS configuration."""
        # 1. Default (TRUST_PROXY_HEADERS=False): X-Forwarded-For is ignored
        with patch("app.config.TRUST_PROXY_HEADERS", False):
            # Exhaust create budget with spoofed header
            for _ in range(WS_RATE_LIMIT_CREATE_PER_MIN):
                with self.client.websocket_connect(
                    "/ws", headers={"x-forwarded-for": "198.51.100.1"}
                ) as ws:
                    ws.send_json({"type": "create"})
                    _ = ws.receive_json()

            # Attempt from another spoofed IP shares the underlying client budget and is throttled
            with self.client.websocket_connect(
                "/ws", headers={"x-forwarded-for": "198.51.100.2"}
            ) as ws:
                ws.send_json({"type": "create"})
                err = ws.receive_json()
                self.assertEqual(err["payload"]["code"], "RATE_LIMITED")

        # Reset rate limiter
        ws_rate_limiter.reset()

        # 2. Enabled (TRUST_PROXY_HEADERS=True): X-Forwarded-For is respected
        with patch("app.config.TRUST_PROXY_HEADERS", True):
            # Exhaust budget for IP 198.51.100.1
            for _ in range(WS_RATE_LIMIT_CREATE_PER_MIN):
                with self.client.websocket_connect(
                    "/ws", headers={"x-forwarded-for": "198.51.100.1"}
                ) as ws:
                    ws.send_json({"type": "create"})
                    _ = ws.receive_json()

            # IP 198.51.100.1 is now throttled
            with self.client.websocket_connect(
                "/ws", headers={"x-forwarded-for": "198.51.100.1"}
            ) as ws:
                ws.send_json({"type": "create"})
                err = ws.receive_json()
                self.assertEqual(err["payload"]["code"], "RATE_LIMITED")

            # Different client IP 198.51.100.2 has its own fresh budget and succeeds!
            with self.client.websocket_connect(
                "/ws", headers={"x-forwarded-for": "198.51.100.2"}
            ) as ws:
                ws.send_json({"type": "create"})
                msg = ws.receive_json()
                self.assertEqual(msg["type"], "room-created")

    def test_window_expiration_restores_capacity_deterministically(self) -> None:
        """Verify capacity restores after window seconds using simulated clock."""
        current_time = 1000.0

        def fake_clock() -> float:
            return current_time

        # Create isolated limiter with fake clock
        test_limiter = InMemoryRateLimiter(clock=fake_clock)

        # Consume 30 units (the join limit)
        for _ in range(WS_RATE_LIMIT_JOIN_PER_MIN):
            allowed, retry_after = test_limiter._sync_acquire(
                "test-key", WS_RATE_LIMIT_JOIN_PER_MIN, WS_RATE_LIMIT_WINDOW_SECONDS
            )
            self.assertTrue(allowed)
            self.assertEqual(retry_after, 0)

        # 31st unit rejected
        allowed, retry_after = test_limiter._sync_acquire(
            "test-key", WS_RATE_LIMIT_JOIN_PER_MIN, WS_RATE_LIMIT_WINDOW_SECONDS
        )
        self.assertFalse(allowed)
        self.assertEqual(retry_after, int(WS_RATE_LIMIT_WINDOW_SECONDS))

        # Advance simulated time past the window (61 seconds)
        current_time += WS_RATE_LIMIT_WINDOW_SECONDS + 1.0

        # Capacity is restored
        allowed, retry_after = test_limiter._sync_acquire(
            "test-key", WS_RATE_LIMIT_JOIN_PER_MIN, WS_RATE_LIMIT_WINDOW_SECONDS
        )
        self.assertTrue(allowed)
        self.assertEqual(retry_after, 0)


# Synchronous helper on InMemoryRateLimiter for deterministic fake-clock tests
def _sync_acquire(self: InMemoryRateLimiter, key: str, limit: int, window_seconds: float) -> tuple[bool, int]:
    """Synchronous version of acquire without async lock, safe for single-threaded tests."""
    now = self._clock()
    self._cleanup_stale_entries(now, window_seconds)

    timestamps = self._entries.get(key)
    if timestamps is None:
        timestamps = []
        self._entries[key] = timestamps

    cutoff = now - window_seconds
    idx = 0
    while idx < len(timestamps) and timestamps[idx] <= cutoff:
        idx += 1
    if idx > 0:
        del timestamps[:idx]

    if len(timestamps) < limit:
        timestamps.append(now)
        return True, 0

    import math
    oldest = timestamps[0]
    remaining = window_seconds - (now - oldest)
    retry_after = max(1, math.ceil(remaining))
    return False, retry_after


InMemoryRateLimiter._sync_acquire = _sync_acquire


if __name__ == "__main__":
    unittest.main()
