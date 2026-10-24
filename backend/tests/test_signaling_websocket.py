"""Integration tests for PairPort WebSocket signaling protocol."""

import json
import time
import unittest
from starlette.testclient import TestClient

from app.main import app
from app.services.room_manager import room_manager


class TestWebSocketSignaling(unittest.TestCase):

    def setUp(self) -> None:
        self.client = TestClient(app)
        # Reset in-memory rooms before each test
        room_manager.rooms.clear()

    def test_room_creation_protocol(self) -> None:
        """Verify client can connect to /ws and create a room."""
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "create"})

            # 1. Server responds with room-created
            msg1 = ws.receive_json()
            self.assertEqual(msg1["type"], "room-created")
            payload1 = msg1["payload"]
            self.assertTrue(payload1["room_code"].startswith("PORT-"))
            self.assertEqual(payload1["role"], "host")
            self.assertTrue(payload1["session_id"])
            self.assertIn("expires_in", payload1)

            # 2. Server immediately sends waiting status
            msg2 = ws.receive_json()
            self.assertEqual(msg2["type"], "waiting")
            self.assertEqual(msg2["payload"]["room_code"], payload1["room_code"])

    def test_join_existing_room_peer_pairing(self) -> None:
        """Verify two clients connect, join the same room, and both receive peer-joined."""
        with self.client.websocket_connect("/ws") as host_ws:
            # Host creates room
            host_ws.send_json({"type": "create"})
            created_event = host_ws.receive_json()
            room_code = created_event["payload"]["room_code"]
            host_session_id = created_event["payload"]["session_id"]
            _ = host_ws.receive_json()  # waiting event

            # Guest joins the room
            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({"type": "join", "payload": {"room_code": room_code}})

                # Guest receives peer-joined
                guest_event = guest_ws.receive_json()
                self.assertEqual(guest_event["type"], "peer-joined")
                self.assertEqual(guest_event["payload"]["room_code"], room_code)
                self.assertEqual(guest_event["payload"]["role"], "guest")
                self.assertEqual(guest_event["payload"]["peer_session_id"], host_session_id)
                guest_session_id = guest_event["payload"]["session_id"]

                # Host receives peer-joined
                host_event = host_ws.receive_json()
                self.assertEqual(host_event["type"], "peer-joined")
                self.assertEqual(host_event["payload"]["room_code"], room_code)
                self.assertEqual(host_event["payload"]["role"], "host")
                self.assertEqual(host_event["payload"]["peer_session_id"], guest_session_id)

    def test_join_invalid_or_nonexistent_room(self) -> None:
        """Verify joining invalid or nonexistent rooms returns structured error events."""
        with self.client.websocket_connect("/ws") as ws:
            # Nonexistent room
            ws.send_json({"type": "join", "payload": {"room_code": "PORT-9999"}})
            err_msg = ws.receive_json()
            self.assertEqual(err_msg["type"], "error")
            self.assertEqual(err_msg["payload"]["code"], "ROOM_NOT_FOUND")

            # Missing room code payload
            ws.send_json({"type": "join", "payload": {}})
            err_msg2 = ws.receive_json()
            self.assertEqual(err_msg2["type"], "error")
            self.assertEqual(err_msg2["payload"]["code"], "MISSING_ROOM_CODE")

    def test_join_full_room_rejected(self) -> None:
        """Verify 3rd participant is rejected when room is full."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            room_code = host_ws.receive_json()["payload"]["room_code"]
            _ = host_ws.receive_json()  # waiting

            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({"type": "join", "payload": {"room_code": room_code}})
                _ = guest_ws.receive_json()  # peer-joined
                _ = host_ws.receive_json()   # peer-joined

                # Third connection attempts to join
                with self.client.websocket_connect("/ws") as third_ws:
                    third_ws.send_json({"type": "join", "payload": {"room_code": room_code}})
                    err_msg = third_ws.receive_json()
                    self.assertEqual(err_msg["type"], "error")
                    self.assertEqual(err_msg["payload"]["code"], "ROOM_FULL")

    def test_invalid_message_handling(self) -> None:
        """Verify malformed JSON or invalid types return structured error messages."""
        with self.client.websocket_connect("/ws") as ws:
            # Malformed JSON
            ws.send_text("not-a-json-payload")
            err1 = ws.receive_json()
            self.assertEqual(err1["type"], "error")
            self.assertEqual(err1["payload"]["code"], "INVALID_JSON")

            # Missing 'type' property
            ws.send_json({"missing_type": True})
            err2 = ws.receive_json()
            self.assertEqual(err2["type"], "error")
            self.assertEqual(err2["payload"]["code"], "INVALID_PROTOCOL")

            # Unknown action
            ws.send_json({"type": "teleport"})
            err3 = ws.receive_json()
            self.assertEqual(err3["type"], "error")
            self.assertEqual(err3["payload"]["code"], "UNKNOWN_ACTION")

    def test_peer_left_on_disconnect(self) -> None:
        """Verify peer-left notification is sent to remaining participant when peer disconnects."""
        host_client = TestClient(app)
        guest_client = TestClient(app)
        with host_client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            room_code = host_ws.receive_json()["payload"]["room_code"]
            _ = host_ws.receive_json()  # waiting

            with guest_client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({"type": "join", "payload": {"room_code": room_code}})
                _ = guest_ws.receive_json()  # guest: peer-joined
                _ = host_ws.receive_json()   # host: peer-joined
                guest_ws.close()

            # guest_ws closed -> disconnected
            # Host should receive peer-left event
            left_event = host_ws.receive_json()
            self.assertEqual(left_event["type"], "peer-left")
            self.assertEqual(left_event["payload"]["room_code"], room_code)

            # Host should then receive waiting event
            waiting_event = host_ws.receive_json()
            self.assertEqual(waiting_event["type"], "waiting")

    def test_voluntary_leave_protocol(self) -> None:
        """Verify voluntary leave message cleans up and notifies remaining peer."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            room_code = host_ws.receive_json()["payload"]["room_code"]
            _ = host_ws.receive_json()  # waiting

            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({"type": "join", "payload": {"room_code": room_code}})
                _ = guest_ws.receive_json()  # guest: peer-joined
                _ = host_ws.receive_json()   # host: peer-joined

                # Guest sends voluntary leave
                guest_ws.send_json({"type": "leave"})
                left_confirm = guest_ws.receive_json()
                self.assertEqual(left_confirm["type"], "left")

                # Host receives peer-left notification
                peer_left_event = host_ws.receive_json()
                self.assertEqual(peer_left_event["type"], "peer-left")

    def test_ping_pong_keepalive(self) -> None:
        """Verify ping message returns pong with server timestamp."""
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            self.assertEqual(pong["type"], "pong")
            self.assertIn("timestamp", pong["payload"])


if __name__ == "__main__":
    unittest.main()
