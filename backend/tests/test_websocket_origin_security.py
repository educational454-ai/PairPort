"""Focused regression tests for WebSocket Origin validation (SEC-01).

Validates that only configured, trusted origins are permitted to establish
WebSocket signaling connections, and that disallowed, malformed, or missing
origins are strictly rejected before accept() with code 1008 (Policy Violation).
"""

from __future__ import annotations

import unittest
from unittest.mock import patch
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import app
from app.config import (
    ALLOWED_ORIGINS,
    get_normalized_allowed_origins,
    is_origin_allowed,
    normalize_origin,
)
from app.services.rate_limiter import ws_rate_limiter
from app.services.room_manager import room_manager


class TestWebSocketOriginSecurity(unittest.TestCase):
    """Test suite covering server-side WebSocket Origin validation."""

    def setUp(self) -> None:
        self.client = TestClient(app)
        room_manager.rooms.clear()
        ws_rate_limiter.reset()

    # -------------------------------------------------------------------------
    # Unit tests for normalize_origin and is_origin_allowed
    # -------------------------------------------------------------------------
    def test_normalize_origin_valid_cases(self) -> None:
        self.assertEqual(normalize_origin("http://localhost:5173"), "http://localhost:5173")
        self.assertEqual(normalize_origin("http://localhost:5173/"), "http://localhost:5173")
        self.assertEqual(normalize_origin("HTTP://LOCALHOST:5173"), "http://localhost:5173")
        self.assertEqual(normalize_origin("http://127.0.0.1:5173"), "http://127.0.0.1:5173")
        self.assertEqual(normalize_origin("http://localhost:80"), "http://localhost")
        self.assertEqual(normalize_origin("https://pairport.app:443"), "https://pairport.app")
        self.assertEqual(normalize_origin("https://pairport.app:8443"), "https://pairport.app:8443")

    def test_normalize_origin_rejects_malformed_and_untrusted(self) -> None:
        # Suffix / subdomain attack
        self.assertIsNone(normalize_origin("http://localhost:5173.evil.com"))
        # Non-HTTP schemes
        self.assertIsNone(normalize_origin("javascript:alert(1)"))
        self.assertIsNone(normalize_origin("ws://localhost:5173"))
        self.assertIsNone(normalize_origin("file:///etc/passwd"))
        # Userinfo injection
        self.assertIsNone(normalize_origin("http://user:pass@localhost:5173"))
        # Path injection
        self.assertIsNone(normalize_origin("http://localhost:5173/evil"))
        # Query string or fragment
        self.assertIsNone(normalize_origin("http://localhost:5173?param=1"))
        self.assertIsNone(normalize_origin("http://localhost:5173#frag"))
        # Null and empty
        self.assertIsNone(normalize_origin("null"))
        self.assertIsNone(normalize_origin(""))
        self.assertIsNone(normalize_origin(None))

    # -------------------------------------------------------------------------
    # Integration tests on WebSocket endpoint: Allowed Origins
    # -------------------------------------------------------------------------
    def test_allowed_development_origin_localhost(self) -> None:
        """Verify standard Vite development origin on localhost is accepted."""
        with self.client.websocket_connect("/ws", headers={"origin": "http://localhost:5173"}) as ws:
            ws.send_json({"type": "create"})
            msg = ws.receive_json()
            self.assertEqual(msg["type"], "room-created")
            self.assertTrue(msg["payload"]["room_code"].startswith("PORT-"))

    def test_allowed_development_origin_loopback_ip(self) -> None:
        """Verify 127.0.0.1 development origin is accepted."""
        with self.client.websocket_connect("/ws", headers={"origin": "http://127.0.0.1:5173"}) as ws:
            ws.send_json({"type": "create"})
            msg = ws.receive_json()
            self.assertEqual(msg["type"], "room-created")

    def test_allowed_production_origin_when_configured(self) -> None:
        """Verify explicitly configured production origin is accepted."""
        custom_origins = ["https://app.pairport.com", "http://localhost:5173"]
        with patch("app.config.ALLOWED_ORIGINS", custom_origins):
            with self.client.websocket_connect("/ws", headers={"origin": "https://app.pairport.com"}) as ws:
                ws.send_json({"type": "create"})
                msg = ws.receive_json()
                self.assertEqual(msg["type"], "room-created")

    # -------------------------------------------------------------------------
    # Integration tests on WebSocket endpoint: Disallowed Origins
    # -------------------------------------------------------------------------
    def test_disallowed_origin_rejected_before_accept(self) -> None:
        """Verify connection from an untrusted origin is closed with 1008 before accept."""
        with self.assertRaises(WebSocketDisconnect) as cm:
            with self.client.websocket_connect("/ws", headers={"origin": "http://evil.com"}) as ws:
                pass
        self.assertEqual(cm.exception.code, 1008)

    def test_disallowed_subdomain_spoof_rejected(self) -> None:
        """Verify origin attempting subdomain suffix spoofing is rejected."""
        with self.assertRaises(WebSocketDisconnect) as cm:
            with self.client.websocket_connect("/ws", headers={"origin": "http://localhost:5173.attacker.com"}) as ws:
                pass
        self.assertEqual(cm.exception.code, 1008)

    def test_disallowed_scheme_spoof_rejected(self) -> None:
        """Verify scheme mismatch (https on localhost port when only http configured) is rejected."""
        with self.assertRaises(WebSocketDisconnect) as cm:
            with self.client.websocket_connect("/ws", headers={"origin": "https://localhost:5173"}) as ws:
                pass
        self.assertEqual(cm.exception.code, 1008)

    def test_null_origin_rejected(self) -> None:
        """Verify 'null' origin (sandboxed iframe / data: URI) is rejected."""
        with self.assertRaises(WebSocketDisconnect) as cm:
            with self.client.websocket_connect("/ws", headers={"origin": "null"}) as ws:
                pass
        self.assertEqual(cm.exception.code, 1008)

    # -------------------------------------------------------------------------
    # Integration tests: Missing Origin Header Policy
    # -------------------------------------------------------------------------
    def test_missing_origin_header_rejected_by_default(self) -> None:
        """Verify connection without an Origin header is rejected with 1008 (policy violation)."""
        with self.assertRaises(WebSocketDisconnect) as cm:
            with self.client.websocket_connect("/ws") as ws:
                pass
        self.assertEqual(cm.exception.code, 1008)

    def test_missing_origin_strictly_rejected_in_production_even_if_flag_disabled(self) -> None:
        """Verify in production mode missing origin cannot be bypassed."""
        with patch("app.config.APP_ENV", "production"):
            with patch("app.config.WS_REQUIRE_ORIGIN", False):
                with self.assertRaises(WebSocketDisconnect) as cm:
                    with self.client.websocket_connect("/ws") as ws:
                        pass
                self.assertEqual(cm.exception.code, 1008)

    # -------------------------------------------------------------------------
    # Integrity and State Isolation
    # -------------------------------------------------------------------------
    def test_rejected_connection_cannot_join_or_alter_room_state(self) -> None:
        """Verify an attacker rejected for bad origin cannot join or modify existing room."""
        # Legitimate host creates room
        host_client = TestClient(app, headers={"origin": "http://localhost:5173"})
        with host_client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            invitation_token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()  # waiting

            room = room_manager.rooms.get(room_code)
            self.assertIsNotNone(room)
            self.assertEqual(len(room.participants), 1)

            # Attacker tries to join with disallowed origin
            attacker_client = TestClient(app, headers={"origin": "http://attacker.org"})
            with self.assertRaises(WebSocketDisconnect) as cm:
                with attacker_client.websocket_connect(f"/ws/{room_code}") as attacker_ws:
                    pass
            self.assertEqual(cm.exception.code, 1008)

            # Room state must remain unaltered (still 1 participant, not full)
            self.assertEqual(len(room.participants), 1)
            self.assertFalse(room.is_full())

            # Legitimate guest joins with allowed origin and valid invitation token
            guest_client = TestClient(app, headers={"origin": "http://127.0.0.1:5173"})
            with guest_client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({
                    "type": "join",
                    "payload": {
                        "room_code": room_code,
                        "invitation_token": invitation_token,
                    },
                })
                guest_msg = guest_ws.receive_json()
                self.assertEqual(guest_msg["type"], "peer-joined")
                self.assertEqual(len(room.participants), 2)
                self.assertTrue(room.is_full())

    def test_path_based_websocket_endpoint_enforces_origin(self) -> None:
        """Verify /ws/{room_code} URL format also strictly validates Origin."""
        with self.assertRaises(WebSocketDisconnect) as cm:
            with self.client.websocket_connect("/ws/PORT-TEST", headers={"origin": "http://evil.com"}) as ws:
                pass
        self.assertEqual(cm.exception.code, 1008)
