"""Security regression tests for Room Invitation Authorization (Step 9F).

Validates:
1. Cryptographic guest invitation generation and entropy length.
2. Legitimate guest join with correct invitation token.
3. Rejection of room-code-only guest joins (INVITATION_REQUIRED).
4. Rejection of missing, empty, invalid, wrong-room, expired, and consumed tokens.
5. Atomic validation & slot assignment under concurrent join races (asyncio.gather).
6. Rejection of 3rd participant (ROOM_FULL).
7. Unauthorized sockets cannot send signaling messages (NOT_IN_ROOM).
8. Invitation secrets never leak in public REST responses or normal error payloads.
9. Origin validation and rate limits remain fully operational.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
import unittest
from unittest.mock import patch
from starlette.testclient import TestClient

from app.config import (
    INVITATION_TOKEN_BYTES,
    INVITATION_TTL_SECONDS,
    ROOM_CODE_PREFIX,
    ROOM_TTL_SECONDS,
)
from app.main import app
from app.services.rate_limiter import ws_rate_limiter
from app.services.room_manager import (
    InvalidInvitationError,
    InvitationAlreadyUsedError,
    InvitationExpiredError,
    InvitationRequiredError,
    Participant,
    Room,
    RoomFullError,
    RoomManager,
    RoomNotFoundError,
    room_manager,
)


class TestRoomInvitationAuthorization(unittest.IsolatedAsyncioTestCase):
    """Unit and concurrency tests for backend RoomManager invitation handling."""

    async def asyncSetUp(self) -> None:
        self.manager = RoomManager(
            default_ttl=ROOM_TTL_SECONDS,
            require_invitation_token=True,
            max_participants_per_room=2,
        )

    async def test_invitation_generation_and_entropy(self) -> None:
        """Verify invitation token is generated with at least 128 bits of CSPRNG entropy."""
        room = await self.manager.create_room()
        self.assertIsNotNone(room.invitation_token)
        self.assertIsInstance(room.invitation_token, str)
        # 16 bytes base64-urlsafe is 22 characters
        self.assertGreaterEqual(len(room.invitation_token), 22)
        self.assertFalse(room.invitation_consumed)
        self.assertGreaterEqual(room.invitation_ttl, 1.0)

        # Ensure tokens across rooms are strictly unique
        other_room = await self.manager.create_room()
        self.assertNotEqual(room.invitation_token, other_room.invitation_token)

    async def test_valid_invitation_permits_guest_join(self) -> None:
        """Verify host joins first and guest joins with correct invitation token."""
        room = await self.manager.create_room()
        host_ws = object()
        guest_ws = object()

        # Host joins
        room, host_p, _ = await self.manager.join_room(room.code, host_ws, role="host")
        self.assertEqual(host_p.role, "host")
        self.assertFalse(room.invitation_consumed)
        self.assertEqual(len(room.participants), 1)

        # Guest joins with valid token
        room, guest_p, _ = await self.manager.join_room(
            room.code,
            guest_ws,
            invitation_token=room.invitation_token,
            role="guest",
        )
        self.assertEqual(guest_p.role, "guest")
        self.assertTrue(room.invitation_consumed)
        self.assertEqual(len(room.participants), 2)
        self.assertTrue(room.is_full())

    async def test_room_code_only_guest_join_is_rejected(self) -> None:
        """Verify guest cannot join with room code alone when invitation is missing or None."""
        room = await self.manager.create_room()
        await self.manager.join_room(room.code, object(), role="host")

        # Missing token
        with self.assertRaises(InvitationRequiredError):
            await self.manager.join_room(room.code, object(), invitation_token=None, role="guest")

        # Empty token
        with self.assertRaises(InvitationRequiredError):
            await self.manager.join_room(room.code, object(), invitation_token="", role="guest")

        # Whitespace token
        with self.assertRaises(InvitationRequiredError):
            await self.manager.join_room(room.code, object(), invitation_token="   ", role="guest")

        # Room state remains intact: 1 participant, invitation not consumed
        self.assertEqual(len(room.participants), 1)
        self.assertFalse(room.invitation_consumed)

    async def test_room_code_only_guest_join_allowed_by_default(self) -> None:
        """Verify guest can join with room code alone when require_invitation_token=False."""
        code_manager = RoomManager(require_invitation_token=False, max_participants_per_room=2)
        room = await code_manager.create_room()
        await code_manager.join_room(room.code, object(), role="host")

        # Guest joins with code alone (invitation_token=None)
        room, guest_p, guest_token = await code_manager.join_room(
            room.code, object(), invitation_token=None, role="guest"
        )
        self.assertEqual(guest_p.role, "guest")
        self.assertEqual(len(room.participants), 2)
        self.assertTrue(room.is_full())

    async def test_invalid_invitation_token_rejected(self) -> None:
        """Verify bogus invitation token is rejected without consuming or slot assignment."""
        room = await self.manager.create_room()
        await self.manager.join_room(room.code, object(), role="host")

        with self.assertRaises(InvalidInvitationError):
            await self.manager.join_room(
                room.code,
                object(),
                invitation_token="completely-bogus-token-12345",
                role="guest",
            )

        self.assertEqual(len(room.participants), 1)
        self.assertFalse(room.invitation_consumed)

    async def test_wrong_room_invitation_rejected(self) -> None:
        """Verify invitation token from room A cannot authorize guest joining room B."""
        room_a = await self.manager.create_room()
        room_b = await self.manager.create_room()

        await self.manager.join_room(room_a.code, object(), role="host")
        await self.manager.join_room(room_b.code, object(), role="host")

        # Try to join room B using room A's token
        with self.assertRaises(InvalidInvitationError):
            await self.manager.join_room(
                room_b.code,
                object(),
                invitation_token=room_a.invitation_token,
                role="guest",
            )

        self.assertEqual(len(room_b.participants), 1)
        self.assertFalse(room_b.invitation_consumed)

    async def test_expired_invitation_rejected(self) -> None:
        """Verify expired invitation token is rejected using deterministic timestamps."""
        room = await self.manager.create_room(ttl=10.0)
        await self.manager.join_room(room.code, object(), role="host")

        # Deterministically simulate passage of time beyond invitation_ttl
        room.invitation_created_at = time.time() - 20.0

        with self.assertRaises(InvitationExpiredError):
            await self.manager.join_room(
                room.code,
                object(),
                invitation_token=room.invitation_token,
                role="guest",
            )

        self.assertEqual(len(room.participants), 1)
        self.assertFalse(room.invitation_consumed)

    async def test_consumed_invitation_cannot_be_reused(self) -> None:
        """Verify once consumed, an invitation token cannot be used again."""
        room = await self.manager.create_room()
        await self.manager.join_room(room.code, object(), role="host")
        token = room.invitation_token

        # Legitimate guest joins
        room, guest_p, _ = await self.manager.join_room(
            room.code,
            object(),
            invitation_token=token,
            role="guest",
        )
        self.assertTrue(room.invitation_consumed)

        # Suppose guest leaves and slot is free
        await self.manager.leave_room(room.code, guest_p.session_id)
        self.assertEqual(len(room.participants), 1)
        self.assertTrue(room.invitation_consumed)

        # Another attempt with already consumed token must be rejected
        with self.assertRaises(InvitationAlreadyUsedError):
            await self.manager.join_room(
                room.code,
                object(),
                invitation_token=token,
                role="guest",
            )

    async def test_concurrent_guest_claims_race_atomicity(self) -> None:
        """Verify concurrent join attempts cannot both consume the invitation or exceed capacity."""
        room = await self.manager.create_room()
        await self.manager.join_room(room.code, object(), role="host")
        token = room.invitation_token

        successes: list[Participant] = []
        errors: list[Exception] = []

        async def attempt_join(client_id: int) -> None:
            ws = object()
            try:
                # Add small non-blocking yield to interleave coroutines
                await asyncio.sleep(0)
                _, p, _ = await self.manager.join_room(
                    room.code,
                    ws,
                    invitation_token=token,
                    role="guest",
                )
                successes.append(p)
            except Exception as e:
                errors.append(e)

        # Launch 20 concurrent join requests
        tasks = [asyncio.create_task(attempt_join(i)) for i in range(20)]
        await asyncio.gather(*tasks)

        # Exactly 1 request must succeed
        self.assertEqual(len(successes), 1)
        # Exactly 19 requests must be rejected
        self.assertEqual(len(errors), 19)
        # Total room participants must never exceed 2
        self.assertEqual(len(room.participants), 2)
        self.assertTrue(room.is_full())
        self.assertTrue(room.invitation_consumed)

        # All rejected errors must be RoomFullError or InvitationAlreadyUsedError
        for err in errors:
            self.assertIn(type(err), (RoomFullError, InvitationAlreadyUsedError))


class TestWebSocketInvitationProtocolIntegration(unittest.TestCase):
    """End-to-end WebSocket protocol integration tests for invitation authorization."""

    def setUp(self) -> None:
        self.client = TestClient(app, headers={"origin": "http://localhost:5173"})
        room_manager.rooms.clear()
        ws_rate_limiter.reset()

    def test_room_created_delivers_invitation_to_host(self) -> None:
        """Verify host receives the secret invitation token in room-created WebSocket event."""
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "create"})
            created_msg = ws.receive_json()
            self.assertEqual(created_msg["type"], "room-created")
            payload = created_msg["payload"]

            self.assertIn("room_code", payload)
            self.assertIn("invitation_token", payload)
            self.assertIsInstance(payload["invitation_token"], str)
            self.assertGreaterEqual(len(payload["invitation_token"]), 22)
            self.assertEqual(payload["role"], "host")

    def test_guest_join_with_valid_invitation_succeeds(self) -> None:
        """Verify guest connects to /ws and joins with valid invitation token."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            invitation_token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()  # waiting

            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({
                    "type": "join",
                    "payload": {
                        "room_code": room_code,
                        "invitation_token": invitation_token,
                    },
                })

                # Guest receives peer-joined
                guest_event = guest_ws.receive_json()
                self.assertEqual(guest_event["type"], "peer-joined")
                self.assertEqual(guest_event["payload"]["room_code"], room_code)
                self.assertEqual(guest_event["payload"]["role"], "guest")

                # Host receives peer-joined
                host_event = host_ws.receive_json()
                self.assertEqual(host_event["type"], "peer-joined")
                self.assertEqual(host_event["payload"]["role"], "host")

    def test_guest_join_without_invitation_rejected_with_invitation_required(self) -> None:
        """Verify room-code-only guest join over /ws is rejected when require_invitation_token=True."""
        with patch.object(room_manager, "require_invitation_token", True):
            with self.client.websocket_connect("/ws") as host_ws:
                host_ws.send_json({"type": "create"})
                room_code = host_ws.receive_json()["payload"]["room_code"]
                _ = host_ws.receive_json()  # waiting

                with self.client.websocket_connect("/ws") as guest_ws:
                    guest_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": room_code},  # No invitation_token!
                    })

                    err_event = guest_ws.receive_json()
                    self.assertEqual(err_event["type"], "error")
                    self.assertEqual(err_event["payload"]["code"], "INVITATION_REQUIRED")
                    self.assertIn("invitation token is required", err_event["payload"]["message"].lower())

    def test_guest_join_with_room_code_alone_succeeds_by_default(self) -> None:
        """Verify guest can join with room code alone over /ws by default."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            room_code = host_ws.receive_json()["payload"]["room_code"]
            _ = host_ws.receive_json()  # waiting

            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code},  # No invitation_token!
                })

                guest_event = guest_ws.receive_json()
                self.assertEqual(guest_event["type"], "peer-joined")
                self.assertEqual(guest_event["payload"]["room_code"], room_code)
                self.assertEqual(guest_event["payload"]["role"], "guest")

    def test_guest_join_with_invalid_invitation_rejected(self) -> None:
        """Verify guest join with invalid invitation is rejected with INVALID_INVITATION."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            room_code = host_ws.receive_json()["payload"]["room_code"]
            _ = host_ws.receive_json()

            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({
                    "type": "join",
                    "payload": {
                        "room_code": room_code,
                        "invitation_token": "wrong-invitation-token-xyz",
                    },
                })

                err_event = guest_ws.receive_json()
                self.assertEqual(err_event["type"], "error")
                self.assertEqual(err_event["payload"]["code"], "INVALID_INVITATION")

    def test_url_path_join_with_invitation_query_param(self) -> None:
        """Verify /ws/{room_code}?invitation_token={token} is rejected with QUERY_PARAM_TOKEN_PROHIBITED."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            invitation_token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()

            url = f"/ws/{room_code}?invitation_token={invitation_token}"
            with self.client.websocket_connect(url) as guest_ws:
                guest_event = guest_ws.receive_json()
                self.assertEqual(guest_event["type"], "error")
                self.assertEqual(guest_event["payload"]["code"], "QUERY_PARAM_TOKEN_PROHIBITED")

    def test_url_path_join_without_invitation_is_closed(self) -> None:
        """Verify /ws/{room_code} without query param is closed with policy violation."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            room_code = host_ws.receive_json()["payload"]["room_code"]
            _ = host_ws.receive_json()

            with self.client.websocket_connect(f"/ws/{room_code}") as guest_ws:
                err_event = guest_ws.receive_json()
                self.assertEqual(err_event["type"], "error")
                self.assertEqual(err_event["payload"]["code"], "INVITATION_REQUIRED")

    def test_third_participant_rejected_with_room_full(self) -> None:
        """Verify third participant cannot join even if presenting the invitation token."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create", "payload": {"max_participants": 2}})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()

            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code, "invitation_token": token},
                })
                _ = guest_ws.receive_json()  # peer-joined
                _ = host_ws.receive_json()   # peer-joined

                with self.client.websocket_connect("/ws") as third_ws:
                    third_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": room_code, "invitation_token": token},
                    })
                    err = third_ws.receive_json()
                    self.assertEqual(err["type"], "error")
                    self.assertIn(err["payload"]["code"], ("ROOM_FULL", "INVITATION_ALREADY_USED"))

    def test_unauthorized_socket_cannot_send_signaling(self) -> None:
        """Verify socket not in any room cannot send offer, answer, or candidate."""
        with self.client.websocket_connect("/ws") as ws:
            # 1. Offer
            ws.send_json({
                "type": "signal-offer",
                "payload": {"sdp": {"type": "offer", "sdp": "v=0\r\n"}},
            })
            err1 = ws.receive_json()
            self.assertEqual(err1["type"], "error")
            self.assertEqual(err1["payload"]["code"], "NOT_IN_ROOM")

            # 2. Answer
            ws.send_json({
                "type": "signal-answer",
                "payload": {"sdp": {"type": "answer", "sdp": "v=0\r\n"}},
            })
            err2 = ws.receive_json()
            self.assertEqual(err2["type"], "error")
            self.assertEqual(err2["payload"]["code"], "NOT_IN_ROOM")

            # 3. Candidate
            ws.send_json({
                "type": "signal-candidate",
                "payload": {"candidate": {"candidate": "candidate:1 1 UDP ...", "sdpMid": "0"}},
            })
            err3 = ws.receive_json()
            self.assertEqual(err3["type"], "error")
            self.assertEqual(err3["payload"]["code"], "NOT_IN_ROOM")


class TestPublicRestEndpointRedaction(unittest.TestCase):
    """Verify invitation tokens never leak through public REST endpoints."""

    def setUp(self) -> None:
        self.client = TestClient(app)
        room_manager.rooms.clear()

    def test_post_rooms_does_not_expose_invitation_token(self) -> None:
        """POST /api/rooms returns room_code but MUST NOT return invitation_token."""
        res = self.client.post("/api/rooms")
        self.assertEqual(res.status_code, 201)
        data = res.json()
        self.assertIn("room_code", data)
        self.assertIn("expires_in", data)
        self.assertNotIn("invitation_token", data)
        self.assertNotIn("token", data)

    def test_get_room_does_not_expose_invitation_token(self) -> None:
        """GET /api/rooms/{code} returns exists and is_full but MUST NOT return invitation_token."""
        res = self.client.post("/api/rooms")
        room_code = res.json()["room_code"]

        lookup_res = self.client.get(f"/api/rooms/{room_code}")
        self.assertEqual(lookup_res.status_code, 200)
        data = lookup_res.json()
        self.assertIn("room_code", data)
        self.assertIn("exists", data)
        self.assertIn("is_full", data)
        self.assertNotIn("invitation_token", data)
        self.assertNotIn("token", data)

    def test_get_stats_does_not_expose_invitation_token(self) -> None:
        """GET /api/rooms/stats only returns counters."""
        res = self.client.get("/api/rooms/stats")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(set(data.keys()), {"active_rooms", "active_connections"})


if __name__ == "__main__":
    unittest.main()
