"""Comprehensive test suite for bounded participant reconnection and host-role authorization hardening.

Covers Step 9J-1 requirements:
1. Host-role takeover prevention and role immutability.
2. Stranger cannot claim host role after host disconnect.
3. Alternate role values cannot bypass invitation checks.
4. Normal host creation and invitation-based guest admission with distinct reconnect credentials.
5. Reconnect credential generation, hashing, and confidentiality (no leakage).
6. Successful reconnect within grace period and credential rotation.
7. Replay rejection of old reconnect tokens.
8. Expired reconnect rejection after grace period deadline.
9. Invalid and missing credentials rejection.
10. Wrong room and unknown participant session rejection.
11. Atomic concurrency on reconnect attempts.
12. Third participant rejection while a slot is reserved for reconnect.
13. Intentional leave immediately revokes reconnect credential and frees room.
14. Stale old-socket cleanup does not evict replacement connection.
15. Deterministic grace-period expiry and room cleanup.
16. WebSocket reconnect rate limiting.
17. Query parameter reconnect token prohibition.
"""

import asyncio
import time
import unittest
from unittest.mock import AsyncMock, patch

from starlette.testclient import TestClient

from app.api.websocket import ws_rate_limiter
from app.config import (
    RECONNECT_GRACE_PERIOD_SECONDS,
    ROOM_TTL_SECONDS,
    WS_RATE_LIMIT_RECONNECT_PER_MIN,
)
from app.main import app
from app.services.room_manager import (
    DuplicateConnectionError,
    InvalidInvitationError,
    InvalidReconnectCredentialError,
    InvitationRequiredError,
    Participant,
    ParticipantNotFoundError,
    ReconnectExpiredError,
    RoomError,
    RoomFullError,
    RoomManager,
    RoomNotFoundError,
    UnauthorizedRoleError,
    hash_reconnect_token,
    verify_reconnect_token,
)


class TestHostRoleTakeoverAndReconnectManager(unittest.IsolatedAsyncioTestCase):
    """Unit tests on RoomManager focusing on host authorization and reconnect mechanics."""

    async def asyncSetUp(self) -> None:
        self.manager = RoomManager(require_invitation_token=True)

    async def test_normal_room_creation_and_guest_admission(self) -> None:
        """Legitimate host creates room and guest joins with invitation token; both get tokens."""
        room = await self.manager.create_room()
        self.assertIsNotNone(room.invitation_token)
        self.assertIsNone(room.host_session_id)

        ws_host = object()
        room, host_p, host_token = await self.manager.join_room(room.code, ws_host, role="host")
        self.assertEqual(host_p.role, "host")
        self.assertEqual(room.host_session_id, host_p.session_id)
        self.assertTrue(host_token)
        self.assertTrue(verify_reconnect_token(host_p.reconnect_token_hash, host_token))

        ws_guest = object()
        room, guest_p, guest_token = await self.manager.join_room(
            room.code, ws_guest, invitation_token=room.invitation_token, role="guest"
        )
        self.assertEqual(guest_p.role, "guest")
        self.assertTrue(guest_token)
        self.assertNotEqual(host_token, guest_token)
        self.assertTrue(verify_reconnect_token(guest_p.reconnect_token_hash, guest_token))
        self.assertEqual(len(room.participants), 2)

    async def test_host_role_takeover_prevention_on_new_join(self) -> None:
        """A new participant can never claim or inherit the host role on an existing room."""
        room = await self.manager.create_room()
        ws_host = object()
        room, host_p, _ = await self.manager.join_room(room.code, ws_host, role="host")

        # Stranger attempts to join as "host"
        with self.assertRaises(RoomFullError):
            await self.manager.join_room(
                room.code, object(), invitation_token=room.invitation_token, role="host"
            )

    async def test_stranger_cannot_claim_host_role_after_host_disconnect(self) -> None:
        """When host unexpectedly disconnects, stranger cannot join as host or hijack the slot."""
        t0 = 1000.0
        room = await self.manager.create_room(now=t0)
        ws_host = object()
        room, host_p, host_token = await self.manager.join_room(room.code, ws_host, role="host", now=t0)

        # Host disconnects unexpectedly at t0 + 5.0
        room, disconnected_host, _ = await self.manager.disconnect_participant(
            room.code, host_p.session_id, ws_host, now=t0 + 5.0
        )
        self.assertEqual(disconnected_host.status, "disconnected")
        self.assertEqual(disconnected_host.disconnected_at, t0 + 5.0)

        # 1. Stranger attempts to join without invitation: rejected
        with self.assertRaises(InvitationRequiredError):
            await self.manager.join_room(room.code, object(), invitation_token=None, role="guest", now=t0 + 10.0)

        # 2. Stranger attempts to join claiming role="host": rejected
        with self.assertRaises(RoomFullError):
            await self.manager.join_room(
                room.code, object(), invitation_token=room.invitation_token, role="host", now=t0 + 10.0
            )

        # 3. Only the genuine host session with the valid reconnect token can reclaim the host seat
        ws_host_reconnect = object()
        room, reconnected_host, new_token, _ = await self.manager.reconnect_participant(
            room.code, host_p.session_id, host_token, ws_host_reconnect, now=t0 + 15.0
        )
        self.assertEqual(reconnected_host.session_id, host_p.session_id)
        self.assertEqual(reconnected_host.role, "host")
        self.assertEqual(reconnected_host.status, "connected")
        self.assertIs(reconnected_host.websocket, ws_host_reconnect)
        self.assertNotEqual(host_token, new_token)
        self.assertTrue(verify_reconnect_token(reconnected_host.reconnect_token_hash, new_token))

    async def test_alternate_roles_cannot_bypass_invitation_check(self) -> None:
        """Attempting to supply unrecognized roles like 'admin', 'moderator', or None still requires invitation."""
        room = await self.manager.create_room()
        ws_host = object()
        await self.manager.join_room(room.code, ws_host, role="host")

        for bad_role in ("admin", "superadmin", "moderator", "guest_override", ""):
            with self.assertRaises(InvitationRequiredError):
                await self.manager.join_room(room.code, object(), invitation_token=None, role=bad_role)

    async def test_successful_reconnect_rotates_credential_and_invalidates_old(self) -> None:
        """Successful reconnect rotates the credential immediately and invalidates previous token."""
        t0 = 2000.0
        room = await self.manager.create_room(now=t0)
        ws_host = object()
        room, host_p, tok1 = await self.manager.join_room(room.code, ws_host, role="host", now=t0)

        # Disconnect host
        await self.manager.disconnect_participant(room.code, host_p.session_id, ws_host, now=t0 + 2.0)

        # Reconnect 1
        ws_host_2 = object()
        room, host_p, tok2, _ = await self.manager.reconnect_participant(
            room.code, host_p.session_id, tok1, ws_host_2, now=t0 + 10.0
        )
        self.assertNotEqual(tok1, tok2)

        # Disconnect host again
        await self.manager.disconnect_participant(room.code, host_p.session_id, ws_host_2, now=t0 + 12.0)

        # Attempt replay with tok1 -> must fail
        with self.assertRaises(InvalidReconnectCredentialError):
            await self.manager.reconnect_participant(
                room.code, host_p.session_id, tok1, object(), now=t0 + 15.0
            )

        # Reconnecting with tok2 -> succeeds
        ws_host_3 = object()
        room, host_p, tok3, _ = await self.manager.reconnect_participant(
            room.code, host_p.session_id, tok2, ws_host_3, now=t0 + 16.0
        )
        self.assertNotEqual(tok2, tok3)
        self.assertEqual(host_p.status, "connected")

    async def test_reconnect_after_grace_period_expires(self) -> None:
        """Reconnect after the grace period deadline has passed is rejected with ReconnectExpiredError."""
        t0 = 3000.0
        room = await self.manager.create_room(now=t0)
        ws_host = object()
        room, host_p, tok = await self.manager.join_room(room.code, ws_host, role="host", now=t0)

        # Disconnect at t0 + 1.0
        await self.manager.disconnect_participant(room.code, host_p.session_id, ws_host, now=t0 + 1.0)

        # Attempt reconnect at t0 + 1.0 + RECONNECT_GRACE_PERIOD_SECONDS + 1.0
        expired_time = t0 + 1.0 + RECONNECT_GRACE_PERIOD_SECONDS + 1.0
        with self.assertRaises(ReconnectExpiredError):
            await self.manager.reconnect_participant(
                room.code, host_p.session_id, tok, object(), now=expired_time
            )

    async def test_invalid_and_missing_reconnect_credentials_rejected(self) -> None:
        """Bogus or empty reconnect tokens are rejected with InvalidReconnectCredentialError."""
        t0 = 4000.0
        room = await self.manager.create_room(now=t0)
        ws_host = object()
        room, host_p, _ = await self.manager.join_room(room.code, ws_host, role="host", now=t0)
        await self.manager.disconnect_participant(room.code, host_p.session_id, ws_host, now=t0 + 1.0)

        for bad_token in ("", "   ", "wrong-token-abc", "x" * 64):
            with self.assertRaises(InvalidReconnectCredentialError):
                await self.manager.reconnect_participant(
                    room.code, host_p.session_id, bad_token, object(), now=t0 + 5.0
                )

    async def test_wrong_room_or_unknown_session_identity_rejected(self) -> None:
        """Attempting to reconnect with wrong room code or non-existent session_id is rejected."""
        t0 = 5000.0
        room1 = await self.manager.create_room(now=t0)
        room2 = await self.manager.create_room(now=t0)
        _, p1, tok1 = await self.manager.join_room(room1.code, object(), role="host", now=t0)
        await self.manager.disconnect_participant(room1.code, p1.session_id, p1.websocket, now=t0 + 1.0)

        # Non-existent session in room 1
        with self.assertRaises(ParticipantNotFoundError):
            await self.manager.reconnect_participant(
                room1.code, "session-does-not-exist", tok1, object(), now=t0 + 2.0
            )

        # Valid session from room 1 used against room 2
        with self.assertRaises(ParticipantNotFoundError):
            await self.manager.reconnect_participant(
                room2.code, p1.session_id, tok1, object(), now=t0 + 2.0
            )

        # Non-existent room code
        with self.assertRaises(RoomNotFoundError):
            await self.manager.reconnect_participant(
                "PORT-NONEXIST", p1.session_id, tok1, object(), now=t0 + 2.0
            )

    async def test_stale_old_socket_cleanup_does_not_evict_replacement_socket(self) -> None:
        """A disconnect callback from a superseded socket must NOT disconnect the replacement socket."""
        t0 = 6000.0
        room = await self.manager.create_room(now=t0)
        ws_old = object()
        room, p, tok = await self.manager.join_room(room.code, ws_old, role="host", now=t0)

        # Participant reconnects on ws_new
        ws_new = object()
        # Mark disconnected first
        await self.manager.disconnect_participant(room.code, p.session_id, ws_old, now=t0 + 1.0)
        # Reconnect succeeds
        room, p, tok2, _ = await self.manager.reconnect_participant(
            room.code, p.session_id, tok, ws_new, now=t0 + 2.0
        )
        self.assertIs(p.websocket, ws_new)
        self.assertEqual(p.status, "connected")

        # Now an old disconnect event from ws_old finally arrives
        room, disconnected_p, _ = await self.manager.disconnect_participant(
            room.code, p.session_id, ws_old, now=t0 + 3.0
        )
        self.assertIsNone(disconnected_p)  # Guarded: not disconnected
        # Participant in room MUST still be connected on ws_new!
        current_p = room.participants[p.session_id]
        self.assertEqual(current_p.status, "connected")
        self.assertIs(current_p.websocket, ws_new)

    async def test_intentional_leave_immediately_revokes_reconnect_access(self) -> None:
        """Voluntary leave clears reconnect credential immediately; reconnect is not permitted."""
        room = await self.manager.create_room()
        _, p1, tok1 = await self.manager.join_room(room.code, object(), role="host")
        _, p2, tok2 = await self.manager.join_room(
            room.code, object(), invitation_token=room.invitation_token, role="guest"
        )

        # Guest intentionally leaves
        updated_room, departed, remaining = await self.manager.leave_room(room.code, p2.session_id)
        self.assertIsNotNone(updated_room)
        self.assertIsNone(departed.reconnect_token_hash)

        # Guest attempts to reconnect
        with self.assertRaises(ParticipantNotFoundError):
            await self.manager.reconnect_participant(
                room.code, p2.session_id, tok2, object()
            )

    async def test_third_participant_rejected_while_slot_is_reserved(self) -> None:
        """When 1 participant is connected and 1 is temporarily disconnected, third client is rejected."""
        t0 = 7000.0
        room = await self.manager.create_room(now=t0)
        _, host_p, _ = await self.manager.join_room(room.code, object(), role="host", now=t0)
        _, guest_p, _ = await self.manager.join_room(
            room.code, object(), invitation_token=room.invitation_token, role="guest", now=t0
        )

        # Guest disconnects unexpectedly
        await self.manager.disconnect_participant(
            room.code, guest_p.session_id, guest_p.websocket, now=t0 + 1.0
        )

        # Third party tries to join
        with self.assertRaises(RoomFullError):
            await self.manager.join_room(
                room.code, object(), invitation_token=room.invitation_token, role="guest", now=t0 + 2.0
            )

    async def test_concurrent_reconnect_attempts_atomic_race(self) -> None:
        """When two reconnect calls race for the same session, exactly one succeeds."""
        t0 = 8000.0
        room = await self.manager.create_room(now=t0)
        ws_initial = object()
        _, host_p, tok = await self.manager.join_room(room.code, ws_initial, role="host", now=t0)
        await self.manager.disconnect_participant(room.code, host_p.session_id, ws_initial, now=t0 + 1.0)

        successes = []
        errors = []

        async def try_reconnect(idx: int) -> None:
            ws = object()
            try:
                await asyncio.sleep(0)  # non-blocking yield to interleave
                _, p, new_tok, _ = await self.manager.reconnect_participant(
                    room.code, host_p.session_id, tok, ws, now=t0 + 2.0
                )
                successes.append((p, new_tok))
            except Exception as e:
                errors.append(e)

        tasks = [asyncio.create_task(try_reconnect(i)) for i in range(10)]
        await asyncio.gather(*tasks)

        self.assertEqual(len(successes), 1)
        self.assertEqual(len(errors), 9)
        # All errors should be DuplicateConnectionError (already connected) or InvalidReconnectCredentialError
        for err in errors:
            self.assertIn(type(err), (DuplicateConnectionError, InvalidReconnectCredentialError))

    async def test_deterministic_grace_period_expiry_and_cleanup(self) -> None:
        """prune_expired_participants deterministically cleans up expired reservations."""
        t0 = 9000.0
        room = await self.manager.create_room(now=t0)
        _, p1, _ = await self.manager.join_room(room.code, object(), role="host", now=t0)
        _, p2, _ = await self.manager.join_room(
            room.code, object(), invitation_token=room.invitation_token, role="guest", now=t0
        )

        # Guest disconnects at t0 + 1.0
        await self.manager.disconnect_participant(room.code, p2.session_id, p2.websocket, now=t0 + 1.0)

        # Advance to before expiry (t0 + 20.0) -> participant still present
        pruned = room.prune_expired_participants(t0 + 20.0, grace_period=RECONNECT_GRACE_PERIOD_SECONDS)
        self.assertEqual(len(pruned), 0)
        self.assertEqual(len(room.participants), 2)

        # Advance past expiry (t0 + 35.0) -> guest pruned
        pruned = room.prune_expired_participants(t0 + 35.0, grace_period=RECONNECT_GRACE_PERIOD_SECONDS)
        self.assertEqual(len(pruned), 1)
        self.assertEqual(pruned[0].session_id, p2.session_id)
        self.assertEqual(len(room.participants), 1)


class TestWebSocketReconnectIntegration(unittest.TestCase):
    """End-to-end WebSocket tests for reconnect protocol, security, and credentials."""

    def setUp(self) -> None:
        self.client = TestClient(app, headers={"origin": "http://localhost:5173"})
        ws_rate_limiter.reset()

    def tearDown(self) -> None:
        ws_rate_limiter.reset()

    def test_reconnect_protocol_end_to_end(self) -> None:
        """Complete workflow: create room, guest joins, guest disconnects, guest reconnects."""
        # 1. Host creates room
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            invitation_token = created["payload"]["invitation_token"]
            host_reconnect_token = created["payload"]["reconnect_token"]
            self.assertTrue(host_reconnect_token)

            # Host receives waiting
            waiting_msg = host_ws.receive_json()
            self.assertEqual(waiting_msg["payload"]["reconnect_token"], host_reconnect_token)

            # 2. Guest joins
            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({
                    "type": "join",
                    "payload": {
                        "room_code": room_code,
                        "invitation_token": invitation_token,
                    },
                })
                guest_joined = guest_ws.receive_json()
                guest_session_id = guest_joined["payload"]["session_id"]
                guest_reconnect_token = guest_joined["payload"]["reconnect_token"]
                self.assertTrue(guest_reconnect_token)
                self.assertNotEqual(host_reconnect_token, guest_reconnect_token)

                # Host receives peer-joined (MUST NOT contain guest's reconnect_token)
                host_peer_joined = host_ws.receive_json()
                self.assertEqual(host_peer_joined["type"], "peer-joined")
                self.assertNotIn("reconnect_token", host_peer_joined["payload"])

                # 3. Guest unexpectedly disconnects (socket closes)
                guest_ws.close()

            # Host receives peer-disconnected
            host_disconnected_evt = host_ws.receive_json()
            self.assertEqual(host_disconnected_evt["type"], "peer-disconnected")
            self.assertEqual(host_disconnected_evt["payload"]["peer_session_id"], guest_session_id)
            self.assertEqual(host_disconnected_evt["payload"]["grace_period"], RECONNECT_GRACE_PERIOD_SECONDS)
            self.assertNotIn("reconnect_token", host_disconnected_evt["payload"])

            # 4. Guest reconnects with new WebSocket
            with self.client.websocket_connect("/ws") as guest_ws_reconnect:
                guest_ws_reconnect.send_json({
                    "type": "reconnect",
                    "payload": {
                        "room_code": room_code,
                        "session_id": guest_session_id,
                        "reconnect_token": guest_reconnect_token,
                    },
                })

                # Guest receives reconnected confirmation with rotated token
                reconnected_msg = guest_ws_reconnect.receive_json()
                self.assertEqual(reconnected_msg["type"], "reconnected")
                self.assertEqual(reconnected_msg["payload"]["room_code"], room_code)
                self.assertEqual(reconnected_msg["payload"]["session_id"], guest_session_id)
                self.assertEqual(reconnected_msg["payload"]["role"], "guest")
                new_guest_token = reconnected_msg["payload"]["reconnect_token"]
                self.assertTrue(new_guest_token)
                self.assertNotEqual(guest_reconnect_token, new_guest_token)

                # Host receives peer-reconnected
                host_reconnected_evt = host_ws.receive_json()
                self.assertEqual(host_reconnected_evt["type"], "peer-reconnected")
                self.assertEqual(host_reconnected_evt["payload"]["peer_session_id"], guest_session_id)
                self.assertEqual(host_reconnected_evt["payload"]["role"], "guest")
                self.assertNotIn("reconnect_token", host_reconnected_evt["payload"])

    def test_reconnect_with_invalid_token_is_rejected(self) -> None:
        """Attempting to reconnect with wrong token fails with INVALID_RECONNECT_TOKEN."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create"})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            session_id = created["payload"]["session_id"]
            _ = host_ws.receive_json()  # waiting
            host_ws.close()

        with self.client.websocket_connect("/ws") as reconnect_ws:
            reconnect_ws.send_json({
                "type": "reconnect",
                "payload": {
                    "room_code": room_code,
                    "session_id": session_id,
                    "reconnect_token": "wrong-bogus-token-123",
                },
            })
            resp = reconnect_ws.receive_json()
            self.assertEqual(resp["type"], "error")
            self.assertEqual(resp["payload"]["code"], "INVALID_RECONNECT_TOKEN")

    def test_reconnect_with_missing_fields_rejected(self) -> None:
        """Missing room_code, session_id, or reconnect_token are rejected with informative error codes."""
        with self.client.websocket_connect("/ws") as ws:
            # Missing room_code
            ws.send_json({"type": "reconnect", "payload": {"session_id": "s1", "reconnect_token": "tok"}})
            resp = ws.receive_json()
            self.assertEqual(resp["payload"]["code"], "MISSING_ROOM_CODE")

            # Missing session_id
            ws.send_json({"type": "reconnect", "payload": {"room_code": "PORT-TEST1", "reconnect_token": "tok"}})
            resp = ws.receive_json()
            self.assertEqual(resp["payload"]["code"], "MISSING_SESSION_ID")

            # Missing reconnect_token
            ws.send_json({"type": "reconnect", "payload": {"room_code": "PORT-TEST1", "session_id": "s1"}})
            resp = ws.receive_json()
            self.assertEqual(resp["payload"]["code"], "MISSING_RECONNECT_TOKEN")

    def test_query_param_reconnect_token_prohibited(self) -> None:
        """Query parameter 'reconnect_token' or 'reconnect' is rejected on legacy WS path."""
        for param in ("reconnect_token", "reconnect"):
            with self.client.websocket_connect(f"/ws/PORT-ABC123?{param}=secret123") as ws:
                resp = ws.receive_json()
                self.assertEqual(resp["type"], "error")
                self.assertEqual(resp["payload"]["code"], "QUERY_PARAM_TOKEN_PROHIBITED")

    def test_no_credential_leakage_in_rest_api(self) -> None:
        """REST room query must never expose reconnect credentials or hashes."""
        # Create a room
        res = self.client.post("/api/rooms")
        self.assertEqual(res.status_code, 201)
        data = res.json()
        room_code = data["room_code"]

        # Check REST query
        query_res = self.client.get(f"/api/rooms/{room_code}")
        self.assertEqual(query_res.status_code, 200)
        query_data = query_res.json()
        self.assertNotIn("reconnect_token", query_data)
        self.assertNotIn("reconnect_token_hash", query_data)
        self.assertNotIn("invitation_token", query_data)

    def test_reconnect_rate_limiting(self) -> None:
        """Reconnect attempts from an IP exceeding WS_RATE_LIMIT_RECONNECT_PER_MIN are rate-limited."""
        ws_rate_limiter.reset()
        for i in range(WS_RATE_LIMIT_RECONNECT_PER_MIN):
            with self.client.websocket_connect("/ws") as ws:
                ws.send_json({
                    "type": "reconnect",
                    "payload": {
                        "room_code": "PORT-RLIMIT",
                        "session_id": f"s-rlimit-{i}",
                        "reconnect_token": "tok-rlimit",
                    },
                })
                # Read response (will be error RoomNotFoundError or InvalidReconnectCredentialError)
                resp = ws.receive_json()
                self.assertEqual(resp["type"], "error")

        # The 31st reconnect attempt from the same IP MUST be blocked by rate limiter
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({
                "type": "reconnect",
                "payload": {
                    "room_code": "PORT-RLIMIT",
                    "session_id": "s-rlimit-overflow",
                    "reconnect_token": "tok-rlimit",
                },
            })
            rl_resp = ws.receive_json()
            self.assertEqual(rl_resp["type"], "error")
            self.assertEqual(rl_resp["payload"]["code"], "RATE_LIMITED")
            self.assertIn("retry_after", rl_resp["payload"])


if __name__ == "__main__":
    unittest.main()
