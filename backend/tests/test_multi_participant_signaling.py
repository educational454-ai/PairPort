"""Integration and regression tests for Multi-Participant Signaling and Target Routing (Phase 1).

Covers:
  - 3- and 4-participant rooms
  - 5th participant capacity rejection
  - Multi-guest invitation claims quota and exhaustion
  - Host invitation revocation (revoke-invitation)
  - Targeted signaling isolation (offers, answers, ICE candidates)
  - Invalid / prohibited signaling targets (self, non-existent, disconnected, missing in multi-peer)
  - Disconnect & reconnect lifecycle with credential rotation in multi-peer rooms
  - 2-person backward compatibility (target_session_id omitted)
  - Roster query and privacy shielding (no token/secret leakage)
"""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch
from starlette.testclient import TestClient

from app.config import (
    MAX_PARTICIPANTS_PER_ROOM,
    ROOM_TTL_SECONDS,
    parse_max_participants,
)
from app.main import app
from app.services.rate_limiter import ws_rate_limiter
from app.services.room_manager import (
    InvalidRoomCapacityError,
    InvitationAlreadyUsedError,
    RoomFullError,
    RoomManager,
    room_manager,
)


class TestConfigMaxParticipants(unittest.TestCase):
    """Regression tests for PAIRPORT_MAX_PARTICIPANTS configuration parsing and validation."""

    def test_missing_or_empty_config_uses_default_4(self) -> None:
        self.assertEqual(parse_max_participants(None), 4)
        self.assertEqual(parse_max_participants(""), 4)
        self.assertEqual(parse_max_participants("   "), 4)

    def test_valid_integer_configurations(self) -> None:
        self.assertEqual(parse_max_participants("2"), 2)
        self.assertEqual(parse_max_participants("3"), 3)
        self.assertEqual(parse_max_participants("4"), 4)
        self.assertEqual(parse_max_participants("8"), 8)
        self.assertEqual(parse_max_participants(" 16 "), 16)

    def test_below_minimum_configurations_raise_value_error(self) -> None:
        for invalid_val in ["1", "0", "-1", "-5"]:
            with self.subTest(val=invalid_val):
                with self.assertRaises(ValueError) as ctx:
                    parse_max_participants(invalid_val)
                self.assertIn("at least 2", str(ctx.exception))

    def test_malformed_configurations_raise_value_error(self) -> None:
        for malformed in ["four", "4.5", "invalid", "2a"]:
            with self.subTest(val=malformed):
                with self.assertRaises(ValueError) as ctx:
                    parse_max_participants(malformed)
                self.assertIn("must be an integer >= 2", str(ctx.exception))

    def test_env_var_integration_reading(self) -> None:
        with patch.dict(os.environ, {"PAIRPORT_MAX_PARTICIPANTS": "6"}):
            self.assertEqual(parse_max_participants(), 6)
        with patch.dict(os.environ, {"PAIRPORT_MAX_PARTICIPANTS": "1"}):
            with self.assertRaises(ValueError):
                parse_max_participants()
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(parse_max_participants(), 4)


class TestMultiParticipantRoomManagerUnit(unittest.IsolatedAsyncioTestCase):
    """Unit tests for RoomManager multi-guest capacity and invitation authorization."""

    async def asyncSetUp(self) -> None:
        self.manager = RoomManager(
            default_ttl=ROOM_TTL_SECONDS,
            require_invitation_token=True,
            max_participants_per_room=4,
        )

    async def test_four_participant_capacity_and_fifth_rejected(self) -> None:
        """Verify 1 host + 3 guests can join, and a 4th guest is rejected with RoomFullError."""
        room = await self.manager.create_room()
        self.assertEqual(room.max_participants, 4)
        token = room.invitation_token

        # 1. Host joins
        _, host, _ = await self.manager.join_room(room.code, object(), role="host")
        self.assertEqual(host.role, "host")
        self.assertFalse(room.is_full())
        self.assertFalse(room.invitation_consumed)
        self.assertEqual(room.invitation_claims_count, 0)

        # 2. Guest 1 joins
        _, g1, _ = await self.manager.join_room(room.code, object(), invitation_token=token, role="guest")
        self.assertEqual(len(room.participants), 2)
        self.assertFalse(room.is_full())
        self.assertFalse(room.invitation_consumed)
        self.assertEqual(room.invitation_claims_count, 1)

        # 3. Guest 2 joins
        _, g2, _ = await self.manager.join_room(room.code, object(), invitation_token=token, role="guest")
        self.assertEqual(len(room.participants), 3)
        self.assertFalse(room.is_full())
        self.assertFalse(room.invitation_consumed)
        self.assertEqual(room.invitation_claims_count, 2)

        # 4. Guest 3 joins (room reaches capacity: 1 host + 3 guests = 4)
        _, g3, _ = await self.manager.join_room(room.code, object(), invitation_token=token, role="guest")
        self.assertEqual(len(room.participants), 4)
        self.assertTrue(room.is_full())
        self.assertTrue(room.invitation_consumed)
        self.assertEqual(room.invitation_claims_count, 3)

        # 5. Guest 4 attempts to join -> RoomFullError
        with self.assertRaises(RoomFullError):
            await self.manager.join_room(room.code, object(), invitation_token=token, role="guest")

    async def test_invitation_revocation_prevents_subsequent_guest_joins(self) -> None:
        """Verify host can revoke invitation token early to prevent further guests from joining."""
        room = await self.manager.create_room()
        token = room.invitation_token

        # Host and Guest 1 join
        await self.manager.join_room(room.code, object(), role="host")
        await self.manager.join_room(room.code, object(), invitation_token=token, role="guest")
        self.assertEqual(len(room.participants), 2)
        self.assertFalse(room.is_full())

        # Host revokes invitation
        room.revoke_invitation()
        self.assertTrue(room.invitation_revoked)
        self.assertTrue(room.invitation_consumed)

        # Guest 2 attempts to join with previously valid token
        with self.assertRaises(InvitationAlreadyUsedError):
            await self.manager.join_room(room.code, object(), invitation_token=token, role="guest")

        self.assertEqual(len(room.participants), 2)

    async def test_direct_create_room_capacity_validation(self) -> None:
        """Verify RoomManager.create_room enforces capacity bounds and leaves no partial state on failure."""
        # 1. Omitted capacity defaults to self.max_participants_per_room (4)
        room_default = await self.manager.create_room()
        self.assertEqual(room_default.max_participants, 4)

        # 2. Valid explicit capacities within [2, max_participants_per_room]
        room_2 = await self.manager.create_room(max_participants=2)
        self.assertEqual(room_2.max_participants, 2)

        room_3 = await self.manager.create_room(max_participants=3)
        self.assertEqual(room_3.max_participants, 3)

        room_4 = await self.manager.create_room(max_participants=4)
        self.assertEqual(room_4.max_participants, 4)

        current_count = len(self.manager.rooms)

        # 3. Below minimum (< 2) rejected with InvalidRoomCapacityError, no partial room state
        for below_min in [1, 0, -1, -10]:
            with self.subTest(below_min=below_min):
                with self.assertRaises(InvalidRoomCapacityError) as ctx:
                    await self.manager.create_room(max_participants=below_min)
                self.assertEqual(ctx.exception.code, "INVALID_ROOM_CAPACITY")
                self.assertEqual(len(self.manager.rooms), current_count)

        # 4. Above maximum (> max_participants_per_room) rejected, no partial room state
        for above_max in [5, 10, 100]:
            with self.subTest(above_max=above_max):
                with self.assertRaises(InvalidRoomCapacityError) as ctx:
                    await self.manager.create_room(max_participants=above_max)
                self.assertEqual(ctx.exception.code, "INVALID_ROOM_CAPACITY")
                self.assertEqual(len(self.manager.rooms), current_count)

        # 5. Non-integer or boolean types rejected, no partial room state
        for invalid_type in [True, False, 3.5, "3"]:  # type: ignore[arg-type]
            with self.subTest(invalid_type=invalid_type):
                with self.assertRaises(InvalidRoomCapacityError) as ctx:
                    await self.manager.create_room(max_participants=invalid_type)  # type: ignore[arg-type]
                self.assertEqual(ctx.exception.code, "INVALID_ROOM_CAPACITY")
                self.assertEqual(len(self.manager.rooms), current_count)


class TestMultiParticipantSignalingIntegration(unittest.TestCase):
    """End-to-end WebSocket tests for 3- and 4-person rooms, targeted signaling, and isolation."""

    def setUp(self) -> None:
        self.client = TestClient(app, headers={"origin": "http://localhost:5173"})
        room_manager.rooms.clear()
        ws_rate_limiter.reset()

    def test_three_participant_room_joins_and_roster_broadcast(self) -> None:
        """Verify 3 participants join and receive correct peer-joined events and rosters."""
        with self.client.websocket_connect("/ws") as host_ws:
            # 1. Host creates room
            host_ws.send_json({"type": "create", "payload": {"max_participants": 4}})
            created = host_ws.receive_json()
            self.assertEqual(created["type"], "room-created")
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            host_session_id = created["payload"]["session_id"]
            self.assertEqual(created["payload"]["max_participants"], 4)

            # Host gets waiting message
            waiting = host_ws.receive_json()
            self.assertEqual(waiting["type"], "waiting")
            self.assertEqual(len(waiting["payload"]["participants"]), 1)

            # 2. Guest 1 joins
            with self.client.websocket_connect("/ws") as g1_ws:
                g1_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code, "invitation_token": token},
                })
                g1_joined = g1_ws.receive_json()
                self.assertEqual(g1_joined["type"], "peer-joined")
                g1_session_id = g1_joined["payload"]["session_id"]
                self.assertEqual(len(g1_joined["payload"]["participants"]), 2)

                host_g1_joined = host_ws.receive_json()
                self.assertEqual(host_g1_joined["type"], "peer-joined")
                self.assertEqual(host_g1_joined["payload"]["peer_session_id"], g1_session_id)
                self.assertEqual(len(host_g1_joined["payload"]["participants"]), 2)

                # 3. Guest 2 joins
                with self.client.websocket_connect("/ws") as g2_ws:
                    g2_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": room_code, "invitation_token": token},
                    })
                    g2_joined = g2_ws.receive_json()
                    self.assertEqual(g2_joined["type"], "peer-joined")
                    g2_session_id = g2_joined["payload"]["session_id"]
                    self.assertEqual(len(g2_joined["payload"]["participants"]), 3)

                    # Host and Guest 1 both receive peer-joined for Guest 2
                    host_g2_joined = host_ws.receive_json()
                    self.assertEqual(host_g2_joined["type"], "peer-joined")
                    self.assertEqual(host_g2_joined["payload"]["peer_session_id"], g2_session_id)
                    self.assertEqual(len(host_g2_joined["payload"]["participants"]), 3)

                    g1_g2_joined = g1_ws.receive_json()
                    self.assertEqual(g1_g2_joined["type"], "peer-joined")
                    self.assertEqual(g1_g2_joined["payload"]["peer_session_id"], g2_session_id)
                    self.assertEqual(len(g1_g2_joined["payload"]["participants"]), 3)

                    # Verify no token or socket leaked in participant rosters
                    for participant_info in g2_joined["payload"]["participants"]:
                        self.assertIn("session_id", participant_info)
                        self.assertIn("role", participant_info)
                        self.assertIn("status", participant_info)
                        self.assertNotIn("reconnect_token", participant_info)
                        self.assertNotIn("websocket", participant_info)

    def test_four_participant_capacity_rejection_over_websocket(self) -> None:
        """Verify 4 participants fill room and 5th connection is rejected over WebSocket."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create", "payload": {"max_participants": 4}})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()  # waiting

            guests = []
            try:
                for i in range(3):
                    ws = self.client.websocket_connect("/ws")
                    g_ws = ws.__enter__()
                    guests.append((ws, g_ws))
                    g_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": room_code, "invitation_token": token},
                    })
                    res = g_ws.receive_json()
                    self.assertEqual(res["type"], "peer-joined")

                # Flush peer-joined notifications on host
                for _ in range(3):
                    _ = host_ws.receive_json()

                # 5th participant attempts to join
                with self.client.websocket_connect("/ws") as fifth_ws:
                    fifth_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": room_code, "invitation_token": token},
                    })
                    err = fifth_ws.receive_json()
                    self.assertEqual(err["type"], "error")
                    self.assertIn(err["payload"]["code"], ("ROOM_FULL", "INVITATION_ALREADY_USED"))
            finally:
                for ws, _ in reversed(guests):
                    ws.__exit__(None, None, None)

    def test_targeted_signaling_isolation_and_relay(self) -> None:
        """Verify signaling (offer, answer, candidate) is delivered ONLY to the target peer."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create", "payload": {"max_participants": 4}})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            host_id = created["payload"]["session_id"]
            _ = host_ws.receive_json()  # waiting

            with self.client.websocket_connect("/ws") as g1_ws:
                g1_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code, "invitation_token": token},
                })
                g1_id = g1_ws.receive_json()["payload"]["session_id"]
                _ = host_ws.receive_json()  # host receives peer-joined

                with self.client.websocket_connect("/ws") as g2_ws:
                    g2_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": room_code, "invitation_token": token},
                    })
                    g2_id = g2_ws.receive_json()["payload"]["session_id"]
                    _ = host_ws.receive_json()  # host receives peer-joined
                    _ = g1_ws.receive_json()    # g1 receives peer-joined

                    # 1. Host sends targeted offer to Guest 1
                    offer_sdp = {"type": "offer", "sdp": "v=0\r\no=host 123 456\r\n"}
                    host_ws.send_json({
                        "type": "signal-offer",
                        "payload": {
                            "target_session_id": g1_id,
                            "sdp": offer_sdp,
                        },
                    })

                    # Guest 1 MUST receive the offer
                    g1_offer = g1_ws.receive_json()
                    self.assertEqual(g1_offer["type"], "signal-offer")
                    self.assertEqual(g1_offer["payload"]["sender_session_id"], host_id)
                    self.assertEqual(g1_offer["payload"]["target_session_id"], g1_id)
                    self.assertEqual(g1_offer["payload"]["sdp"]["sdp"], offer_sdp["sdp"])

                    # Guest 2 sends a ping to confirm NO offer was delivered to Guest 2
                    g2_ws.send_json({"type": "ping"})
                    g2_pong = g2_ws.receive_json()
                    self.assertEqual(g2_pong["type"], "pong")

                    # 2. Guest 1 sends targeted answer to Host
                    answer_sdp = {"type": "answer", "sdp": "v=0\r\no=g1 789 012\r\n"}
                    g1_ws.send_json({
                        "type": "signal-answer",
                        "payload": {
                            "target_session_id": host_id,
                            "sdp": answer_sdp,
                        },
                    })

                    # Host MUST receive the answer
                    host_answer = host_ws.receive_json()
                    self.assertEqual(host_answer["type"], "signal-answer")
                    self.assertEqual(host_answer["payload"]["sender_session_id"], g1_id)
                    self.assertEqual(host_answer["payload"]["target_session_id"], host_id)
                    self.assertEqual(host_answer["payload"]["sdp"]["sdp"], answer_sdp["sdp"])

                    # Guest 2 confirms NO answer was received
                    g2_ws.send_json({"type": "ping"})
                    g2_pong2 = g2_ws.receive_json()
                    self.assertEqual(g2_pong2["type"], "pong")

                    # 3. Host sends targeted candidate to Guest 1
                    candidate_data = {"candidate": "candidate:1 1 UDP 2122260223 192.168.1.1 5000 typ host", "sdpMid": "0", "sdpMLineIndex": 0}
                    host_ws.send_json({
                        "type": "signal-candidate",
                        "payload": {
                            "target_session_id": g1_id,
                            "candidate": candidate_data,
                        },
                    })

                    # Guest 1 receives candidate
                    g1_cand = g1_ws.receive_json()
                    self.assertEqual(g1_cand["type"], "signal-candidate")
                    self.assertEqual(g1_cand["payload"]["sender_session_id"], host_id)
                    self.assertEqual(g1_cand["payload"]["candidate"]["candidate"], candidate_data["candidate"])

                    # Guest 2 confirms NO candidate received
                    g2_ws.send_json({"type": "ping"})
                    g2_pong3 = g2_ws.receive_json()
                    self.assertEqual(g2_pong3["type"], "pong")

    def test_targeted_signaling_validation_errors(self) -> None:
        """Verify signaling validation rejects self, non-existent, and missing targets in multi-peer rooms."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create", "payload": {"max_participants": 4}})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            host_id = created["payload"]["session_id"]
            _ = host_ws.receive_json()  # waiting

            with self.client.websocket_connect("/ws") as g1_ws:
                g1_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code, "invitation_token": token},
                })
                g1_id = g1_ws.receive_json()["payload"]["session_id"]
                _ = host_ws.receive_json()

                with self.client.websocket_connect("/ws") as g2_ws:
                    g2_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": room_code, "invitation_token": token},
                    })
                    g2_id = g2_ws.receive_json()["payload"]["session_id"]
                    _ = host_ws.receive_json()
                    _ = g1_ws.receive_json()

                    offer_payload = {"type": "offer", "sdp": "v=0\r\n"}

                    # Case A: Missing target in 3-participant room -> TARGET_REQUIRED
                    host_ws.send_json({
                        "type": "signal-offer",
                        "payload": {"sdp": offer_payload},
                    })
                    err1 = host_ws.receive_json()
                    self.assertEqual(err1["type"], "error")
                    self.assertEqual(err1["payload"]["code"], "TARGET_REQUIRED")

                    # Case B: Target self -> INVALID_TARGET
                    host_ws.send_json({
                        "type": "signal-offer",
                        "payload": {"target_session_id": host_id, "sdp": offer_payload},
                    })
                    err2 = host_ws.receive_json()
                    self.assertEqual(err2["type"], "error")
                    self.assertEqual(err2["payload"]["code"], "INVALID_TARGET")

                    # Case C: Target not in room -> TARGET_NOT_FOUND
                    host_ws.send_json({
                        "type": "signal-offer",
                        "payload": {"target_session_id": "bogus-target-session", "sdp": offer_payload},
                    })
                    err3 = host_ws.receive_json()
                    self.assertEqual(err3["type"], "error")
                    self.assertEqual(err3["payload"]["code"], "TARGET_NOT_FOUND")

    def test_signaling_to_disconnected_target_rejected(self) -> None:
        """Verify signaling directed to a temporarily disconnected peer returns TARGET_NOT_CONNECTED."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create", "payload": {"max_participants": 4}})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()

            # Keep Guest 2 open so the room remains a multi-peer room (host + g2)
            with self.client.websocket_connect("/ws") as g2_ws:
                g2_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code, "invitation_token": token},
                })
                _ = g2_ws.receive_json()
                _ = host_ws.receive_json()

                # Guest 1 connects and then closes abruptly
                with self.client.websocket_connect("/ws") as g1_ws:
                    g1_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": room_code, "invitation_token": token},
                    })
                    g1_id = g1_ws.receive_json()["payload"]["session_id"]
                    _ = host_ws.receive_json()
                    _ = g2_ws.receive_json()
                    g1_ws.close()

                # g1_ws closed abruptly
                # Host receives peer-disconnected for g1
                discon = host_ws.receive_json()
                self.assertEqual(discon["type"], "peer-disconnected")
                self.assertEqual(discon["payload"]["peer_session_id"], g1_id)

                # Host attempts to send offer to disconnected g1
                host_ws.send_json({
                    "type": "signal-offer",
                    "payload": {
                        "target_session_id": g1_id,
                        "sdp": {"type": "offer", "sdp": "v=0\r\n"},
                    },
                })
                err = host_ws.receive_json()
                self.assertEqual(err["type"], "error")
                self.assertEqual(err["payload"]["code"], "TARGET_NOT_CONNECTED")

    def test_reconnect_lifecycle_in_multi_participant_room(self) -> None:
        """Verify peer disconnects, other peers receive notification, and reconnect restores session."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create", "payload": {"max_participants": 4}})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()

            with self.client.websocket_connect("/ws") as g2_ws:
                g2_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code, "invitation_token": token},
                })
                _ = g2_ws.receive_json()
                _ = host_ws.receive_json()

                # Guest 1 connects
                with self.client.websocket_connect("/ws") as g1_ws:
                    g1_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": room_code, "invitation_token": token},
                    })
                    g1_joined = g1_ws.receive_json()
                    g1_id = g1_joined["payload"]["session_id"]
                    g1_reconnect_token = g1_joined["payload"]["reconnect_token"]
                    _ = host_ws.receive_json()
                    _ = g2_ws.receive_json()
                    g1_ws.close()

                # g1 disconnected
                host_discon = host_ws.receive_json()
                self.assertEqual(host_discon["type"], "peer-disconnected")
                self.assertEqual(host_discon["payload"]["peer_session_id"], g1_id)

                g2_discon = g2_ws.receive_json()
                self.assertEqual(g2_discon["type"], "peer-disconnected")
                self.assertEqual(g2_discon["payload"]["peer_session_id"], g1_id)

                # g1 reconnects with session_id and reconnect_token
                with self.client.websocket_connect("/ws") as g1_reconnected_ws:
                    g1_reconnected_ws.send_json({
                        "type": "reconnect",
                        "payload": {
                            "room_code": room_code,
                            "session_id": g1_id,
                            "reconnect_token": g1_reconnect_token,
                        },
                    })
                    reconnected_msg = g1_reconnected_ws.receive_json()
                    self.assertEqual(reconnected_msg["type"], "reconnected")
                    new_reconnect_token = reconnected_msg["payload"]["reconnect_token"]
                    self.assertNotEqual(new_reconnect_token, g1_reconnect_token)

                    # Host and Guest 2 receive peer-reconnected
                    host_recon = host_ws.receive_json()
                    self.assertEqual(host_recon["type"], "peer-reconnected")
                    self.assertEqual(host_recon["payload"]["peer_session_id"], g1_id)

                    g2_recon = g2_ws.receive_json()
                    self.assertEqual(g2_recon["type"], "peer-reconnected")
                    self.assertEqual(g2_recon["payload"]["peer_session_id"], g1_id)

    def test_two_person_backward_compatibility_signaling_without_target(self) -> None:
        """Verify in a 2-person room, omitting target_session_id routes to the other peer automatically."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create", "payload": {"max_participants": 2}})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            host_id = created["payload"]["session_id"]
            _ = host_ws.receive_json()

            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code, "invitation_token": token},
                })
                guest_joined = guest_ws.receive_json()
                guest_id = guest_joined["payload"]["session_id"]
                self.assertEqual(guest_joined["payload"]["peer_session_id"], host_id)
                host_joined = host_ws.receive_json()
                self.assertEqual(host_joined["payload"]["peer_session_id"], guest_id)

                # Host sends offer WITHOUT target_session_id
                offer_sdp = {"type": "offer", "sdp": "v=0\r\no=legacy 1 2\r\n"}
                host_ws.send_json({
                    "type": "signal-offer",
                    "payload": {"sdp": offer_sdp},
                })

                # Guest receives offer
                relayed_offer = guest_ws.receive_json()
                self.assertEqual(relayed_offer["type"], "signal-offer")
                self.assertEqual(relayed_offer["payload"]["sender_session_id"], host_id)
                self.assertEqual(relayed_offer["payload"]["sdp"]["sdp"], offer_sdp["sdp"])

                # Guest sends answer WITHOUT target_session_id
                answer_sdp = {"type": "answer", "sdp": "v=0\r\no=legacy 3 4\r\n"}
                guest_ws.send_json({
                    "type": "signal-answer",
                    "payload": {"sdp": answer_sdp},
                })

                # Host receives answer
                relayed_answer = host_ws.receive_json()
                self.assertEqual(relayed_answer["type"], "signal-answer")
                self.assertEqual(relayed_answer["payload"]["sender_session_id"], guest_id)
                self.assertEqual(relayed_answer["payload"]["sdp"]["sdp"], answer_sdp["sdp"])

    def test_roster_query_and_invitation_revocation_actions(self) -> None:
        """Verify 'roster' query returns sanitized participants and 'revoke-invitation' works for host only."""
        with self.client.websocket_connect("/ws") as host_ws:
            host_ws.send_json({"type": "create", "payload": {"max_participants": 4}})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()

            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code, "invitation_token": token},
                })
                _ = guest_ws.receive_json()
                _ = host_ws.receive_json()

                # 1. Roster query
                guest_ws.send_json({"type": "roster"})
                roster_msg = guest_ws.receive_json()
                self.assertEqual(roster_msg["type"], "room-roster")
                self.assertEqual(roster_msg["payload"]["room_code"], room_code)
                self.assertEqual(len(roster_msg["payload"]["participants"]), 2)

                # 2. Guest attempts to revoke invitation -> UNAUTHORIZED_ROLE
                guest_ws.send_json({"type": "revoke-invitation"})
                err = guest_ws.receive_json()
                self.assertEqual(err["type"], "error")
                self.assertEqual(err["payload"]["code"], "UNAUTHORIZED_ROLE")

                # 3. Host revokes invitation -> succeeds
                host_ws.send_json({"type": "revoke-invitation"})
                revoked_msg = host_ws.receive_json()
                self.assertEqual(revoked_msg["type"], "invitation-revoked")
                self.assertEqual(revoked_msg["payload"]["room_code"], room_code)

                # 4. Another guest attempts to join using the revoked token -> rejected
                with self.client.websocket_connect("/ws") as third_ws:
                    third_ws.send_json({
                        "type": "join",
                        "payload": {"room_code": room_code, "invitation_token": token},
                    })
                    join_err = third_ws.receive_json()
                    self.assertEqual(join_err["type"], "error")
                    self.assertEqual(join_err["payload"]["code"], "INVITATION_ALREADY_USED")

    def test_rate_limited_invitation_revocation_does_not_revoke(self) -> None:
        """Verify that a rate-limited revoke-invitation action does not change invitation state,
        and that an authorized request can revoke successfully when allowed.
        """
        with self.client.websocket_connect("/ws") as host_ws:
            # 1. Host creates room with max_participants=4
            host_ws.send_json({"type": "create", "payload": {"max_participants": 4}})
            created = host_ws.receive_json()
            room_code = created["payload"]["room_code"]
            token = created["payload"]["invitation_token"]
            _ = host_ws.receive_json()  # waiting message

            # 2. Host exhausts the 10-action per 10s sliding window limit
            # Send 10 room operations (e.g. invalid reconnects)
            for _ in range(10):
                host_ws.send_json({
                    "type": "reconnect",
                    "payload": {
                        "room_code": room_code,
                        "session_id": "nonexistent-sess",
                        "reconnect_token": "dummy-token",
                    },
                })
                resp = host_ws.receive_json()
                self.assertEqual(resp["type"], "error")

            # 3. 11th room operation: Host attempts to revoke invitation while rate-limited
            host_ws.send_json({"type": "revoke-invitation"})
            rate_limit_resp = host_ws.receive_json()
            self.assertEqual(rate_limit_resp["type"], "error")
            self.assertEqual(rate_limit_resp["payload"]["code"], "RATE_LIMITED")
            self.assertIn("Too many room actions", rate_limit_resp["payload"]["message"])

            # 4. Verify invitation state did NOT change:
            # Connect a guest over WebSocket and verify they can still join using the token
            with self.client.websocket_connect("/ws") as guest_ws:
                guest_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code, "invitation_token": token},
                })
                join_resp = guest_ws.receive_json()
                self.assertEqual(join_resp["type"], "peer-joined")
                self.assertEqual(len(join_resp["payload"]["participants"]), 2)
                _ = host_ws.receive_json()  # host receives peer-joined

                # Guest leaves
                guest_ws.send_json({"type": "leave"})
                _ = guest_ws.receive_json()
                _ = host_ws.receive_json()  # host receives peer-left

        # 5. Verify that an authorized host connection with available budget CAN revoke successfully
        with self.client.websocket_connect("/ws") as host2_ws:
            host2_ws.send_json({"type": "create", "payload": {"max_participants": 4}})
            created2 = host2_ws.receive_json()
            room_code2 = created2["payload"]["room_code"]
            token2 = created2["payload"]["invitation_token"]
            _ = host2_ws.receive_json()  # waiting

            # Host revokes without being rate-limited
            host2_ws.send_json({"type": "revoke-invitation"})
            revoked2 = host2_ws.receive_json()
            self.assertEqual(revoked2["type"], "invitation-revoked")
            self.assertEqual(revoked2["payload"]["room_code"], room_code2)

            # Guest join attempt with revoked token is rejected
            with self.client.websocket_connect("/ws") as guest2_ws:
                guest2_ws.send_json({
                    "type": "join",
                    "payload": {"room_code": room_code2, "invitation_token": token2},
                })
                rejected2 = guest2_ws.receive_json()
                self.assertEqual(rejected2["type"], "error")
                self.assertEqual(rejected2["payload"]["code"], "INVITATION_ALREADY_USED")
