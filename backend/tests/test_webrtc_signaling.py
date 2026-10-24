"""Tests for WebRTC offer, answer, candidate relays, and security validations."""

import unittest
from starlette.testclient import TestClient

from app.main import app
from app.services.room_manager import room_manager


class TestWebRTCSignalingRelay(unittest.TestCase):

    def setUp(self) -> None:
        self.client = TestClient(app, headers={"origin": "http://localhost:5173"})
        room_manager.rooms.clear()

    def test_offer_and_answer_relay(self) -> None:
        """Verify host offer is relayed to guest, and guest answer is relayed to host."""
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
                _ = guest_ws.receive_json()  # guest: peer-joined
                _ = host_ws.receive_json()   # host: peer-joined

                # 1. Host sends WebRTC offer
                sample_offer_sdp = {"type": "offer", "sdp": "v=0\r\no=- 1234 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"}
                host_ws.send_json({
                    "type": "signal-offer",
                    "payload": {"sdp": sample_offer_sdp},
                })

                # Guest should receive relayed offer
                guest_offer_msg = guest_ws.receive_json()
                self.assertEqual(guest_offer_msg["type"], "signal-offer")
                self.assertEqual(guest_offer_msg["payload"]["room_code"], room_code)
                self.assertEqual(guest_offer_msg["payload"]["sdp"]["type"], "offer")
                self.assertEqual(guest_offer_msg["payload"]["sdp"]["sdp"], sample_offer_sdp["sdp"])

                # 2. Guest sends WebRTC answer
                sample_answer_sdp = {"type": "answer", "sdp": "v=0\r\no=- 5678 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"}
                guest_ws.send_json({
                    "type": "signal-answer",
                    "payload": {"sdp": sample_answer_sdp},
                })

                # Host should receive relayed answer
                host_answer_msg = host_ws.receive_json()
                self.assertEqual(host_answer_msg["type"], "signal-answer")
                self.assertEqual(host_answer_msg["payload"]["room_code"], room_code)
                self.assertEqual(host_answer_msg["payload"]["sdp"]["type"], "answer")
                self.assertEqual(host_answer_msg["payload"]["sdp"]["sdp"], sample_answer_sdp["sdp"])

                # 3. Phase 6: Host triggers bounded ICE restart renegotiation offer
                restart_offer_sdp = {
                    "type": "offer",
                    "sdp": "v=0\r\no=- 9999 3 IN IP4 127.0.0.1\r\na=ice-options:trickle\r\na=ice-pwd:newpass\r\n",
                }
                host_ws.send_json({
                    "type": "signal-offer",
                    "payload": {"sdp": restart_offer_sdp},
                })

                # Guest must receive relayed ICE restart offer
                guest_restart_msg = guest_ws.receive_json()
                self.assertEqual(guest_restart_msg["type"], "signal-offer")
                self.assertEqual(guest_restart_msg["payload"]["sdp"]["sdp"], restart_offer_sdp["sdp"])

                # Guest sends renegotiated answer
                restart_answer_sdp = {
                    "type": "answer",
                    "sdp": "v=0\r\no=- 8888 3 IN IP4 127.0.0.1\r\na=ice-pwd:guestpass\r\n",
                }
                guest_ws.send_json({
                    "type": "signal-answer",
                    "payload": {"sdp": restart_answer_sdp},
                })
                host_restart_ans_msg = host_ws.receive_json()
                self.assertEqual(host_restart_ans_msg["type"], "signal-answer")
                self.assertEqual(host_restart_ans_msg["payload"]["sdp"]["sdp"], restart_answer_sdp["sdp"])

    def test_ice_candidate_relay(self) -> None:
        """Verify ICE candidates are relayed bidirectionally."""
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
                _ = guest_ws.receive_json()  # guest: peer-joined
                _ = host_ws.receive_json()   # host: peer-joined

                # Host sends candidate to guest
                candidate_data = {
                    "candidate": "candidate:1 1 UDP 2130706431 192.168.1.100 50000 typ host",
                    "sdpMid": "0",
                    "sdpMLineIndex": 0,
                }
                host_ws.send_json({
                    "type": "signal-candidate",
                    "payload": {"candidate": candidate_data},
                })

                guest_cand_msg = guest_ws.receive_json()
                self.assertEqual(guest_cand_msg["type"], "signal-candidate")
                self.assertEqual(guest_cand_msg["payload"]["candidate"]["candidate"], candidate_data["candidate"])

                # Guest sends null candidate (end of candidates)
                guest_ws.send_json({
                    "type": "signal-candidate",
                    "payload": {"candidate": None},
                })
                host_cand_msg = host_ws.receive_json()
                self.assertEqual(host_cand_msg["type"], "signal-candidate")
                self.assertIsNone(host_cand_msg["payload"]["candidate"])

    def test_reject_signaling_when_not_in_room(self) -> None:
        """Verify offer/answer/candidate without joining a room returns NOT_IN_ROOM error."""
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({
                "type": "signal-offer",
                "payload": {"sdp": {"type": "offer", "sdp": "sample"}},
            })
            err = ws.receive_json()
            self.assertEqual(err["type"], "error")
            self.assertEqual(err["payload"]["code"], "NOT_IN_ROOM")

    def test_reject_signaling_when_no_peer_in_room(self) -> None:
        """Verify host cannot send offer if no peer has joined yet."""
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "create"})
            _ = ws.receive_json()  # room-created
            _ = ws.receive_json()  # waiting

            ws.send_json({
                "type": "signal-offer",
                "payload": {"sdp": {"type": "offer", "sdp": "sample"}},
            })
            err = ws.receive_json()
            self.assertEqual(err["type"], "error")
            self.assertEqual(err["payload"]["code"], "NO_PEER_IN_ROOM")

    def test_reject_malformed_sdp(self) -> None:
        """Verify malformed SDP payloads are rejected with clear error."""
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
                _ = guest_ws.receive_json()  # peer-joined
                _ = host_ws.receive_json()   # peer-joined

                # Wrong SDP type in payload
                host_ws.send_json({
                    "type": "signal-offer",
                    "payload": {"sdp": {"type": "answer", "sdp": "v=0"}},
                })
                err = host_ws.receive_json()
                self.assertEqual(err["type"], "error")
                self.assertEqual(err["payload"]["code"], "INVALID_OFFER")

                # Missing SDP dictionary
                host_ws.send_json({
                    "type": "signal-offer",
                    "payload": {"sdp": "not-a-dict"},
                })
                err2 = host_ws.receive_json()
                self.assertEqual(err2["type"], "error")
                self.assertEqual(err2["payload"]["code"], "INVALID_OFFER")

    def test_reject_chat_on_signaling_websocket(self) -> None:
        """Verify chat messages sent to signaling endpoint are explicitly rejected."""
        with self.client.websocket_connect("/ws") as ws:
            ws.send_json({
                "type": "chat",
                "payload": {"text": "Hello over websocket?"},
            })
            err = ws.receive_json()
            self.assertEqual(err["type"], "error")
            self.assertEqual(err["payload"]["code"], "CHAT_NOT_ALLOWED_ON_SIGNALING")

    def test_reject_file_transfer_on_signaling_websocket(self) -> None:
        """Verify file payloads and chunks sent to signaling are rejected to protect server resources."""
        file_types = ["file", "file-meta", "file-chunk", "file-data", "file-transfer"]
        with self.client.websocket_connect("/ws") as ws:
            for f_type in file_types:
                ws.send_json({
                    "type": f_type,
                    "payload": {"name": "secret.pdf", "size": 1024, "chunk": "AAAA"},
                })
                err = ws.receive_json()
                self.assertEqual(err["type"], "error")
                self.assertEqual(err["payload"]["code"], "FILE_TRANSFER_NOT_ALLOWED_ON_SIGNALING")
                self.assertIn("WebRTC DataChannel", err["payload"]["message"])


if __name__ == "__main__":
    unittest.main()
