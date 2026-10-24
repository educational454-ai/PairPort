"""Tests for PairPort REST endpoints."""

import unittest
from starlette.testclient import TestClient

from app.config import ROOM_CODE_LENGTH, ROOM_CODE_PREFIX
from app.main import app
from app.services.room_manager import room_manager


class TestRoomsAPI(unittest.TestCase):

    def setUp(self) -> None:
        self.client = TestClient(app)
        room_manager.rooms.clear()

    def test_health_check(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["service"], "pairport-api")
        self.assertIn("active_rooms", data)

    def test_create_room_rest(self) -> None:
        response = self.client.post("/api/rooms")
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertTrue(data["room_code"].startswith(ROOM_CODE_PREFIX))
        self.assertEqual(len(data["room_code"]), len(ROOM_CODE_PREFIX) + ROOM_CODE_LENGTH)
        self.assertEqual(data["max_participants"], 2)

    def test_check_room_status_rest(self) -> None:
        # Create a room first
        create_res = self.client.post("/api/rooms")
        code = create_res.json()["room_code"]

        # Check existing room with canonical format
        check_res = self.client.get(f"/api/rooms/{code}")
        self.assertEqual(check_res.status_code, 200)
        data = check_res.json()
        self.assertEqual(data["room_code"], code)
        self.assertTrue(data["exists"])
        self.assertFalse(data["is_full"])

        # Check existing room with unprefixed lowercase format
        suffix = code.split("-")[1].lower()
        unprefixed_res = self.client.get(f"/api/rooms/{suffix}")
        self.assertEqual(unprefixed_res.status_code, 200)
        self.assertEqual(unprefixed_res.json()["room_code"], code)

        # Check nonexistent room
        not_found_res = self.client.get("/api/rooms/PORT-999999")
        self.assertEqual(not_found_res.status_code, 404)

        # Check invalid formats return 400
        bad_length_res = self.client.get("/api/rooms/ab")
        self.assertEqual(bad_length_res.status_code, 400)

        bad_char_res = self.client.get("/api/rooms/PORT-INV!9X")
        self.assertEqual(bad_char_res.status_code, 400)


if __name__ == "__main__":
    unittest.main()
