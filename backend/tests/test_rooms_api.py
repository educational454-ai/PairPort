import unittest
from starlette.testclient import TestClient

from app.config import (
    REST_RATE_LIMIT_CHECK_ROOM_PER_MIN,
    REST_RATE_LIMIT_CREATE_ROOM_PER_MIN,
    ROOM_CODE_LENGTH,
    ROOM_CODE_PREFIX,
)
from app.main import app
from app.services.rate_limiter import rest_rate_limiter
from app.services.room_manager import room_manager


class TestRoomsAPI(unittest.TestCase):

    def setUp(self) -> None:
        self.client = TestClient(app)
        room_manager.rooms.clear()
        rest_rate_limiter.reset()

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

    def test_check_room_status_rest_and_redaction(self) -> None:
        """Verify room lookup succeeds and participants_count is strictly redacted."""
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

        # Security check: verify participants_count is redacted
        self.assertNotIn("participants_count", data)

        # Check existing room with unprefixed lowercase format
        suffix = code.split("-")[1].lower()
        unprefixed_res = self.client.get(f"/api/rooms/{suffix}")
        self.assertEqual(unprefixed_res.status_code, 200)
        self.assertEqual(unprefixed_res.json()["room_code"], code)
        self.assertNotIn("participants_count", unprefixed_res.json())

        # Check nonexistent room
        not_found_res = self.client.get("/api/rooms/PORT-999999")
        self.assertEqual(not_found_res.status_code, 404)

        # Check invalid formats return 400
        bad_length_res = self.client.get("/api/rooms/ab")
        self.assertEqual(bad_length_res.status_code, 400)

        bad_char_res = self.client.get("/api/rooms/PORT-INV!9X")
        self.assertEqual(bad_char_res.status_code, 400)

    def test_create_room_rate_limiting(self) -> None:
        """Verify POST /api/rooms enforces configured limit and returns 429 with Retry-After."""
        client_a = TestClient(app, client=("192.168.1.10", 50000))
        client_b = TestClient(app, client=("192.168.1.20", 50000))

        # First 5 calls from client_a should succeed
        for _ in range(REST_RATE_LIMIT_CREATE_ROOM_PER_MIN):
            res = client_a.post("/api/rooms")
            self.assertEqual(res.status_code, 201)

        # 6th call from client_a should be rate limited
        limited_res = client_a.post("/api/rooms")
        self.assertEqual(limited_res.status_code, 429)
        self.assertIn("retry-after", limited_res.headers)
        retry_after = int(limited_res.headers["retry-after"])
        self.assertGreater(retry_after, 0)
        self.assertIn("Too many room creation requests", limited_res.json()["detail"])

        # client_b with a different IP should not be blocked
        client_b_res = client_b.post("/api/rooms")
        self.assertEqual(client_b_res.status_code, 201)

    def test_check_room_rate_limiting(self) -> None:
        """Verify GET /api/rooms/{code} enforces configured limit and returns 429 with Retry-After."""
        client_a = TestClient(app, client=("192.168.1.30", 50000))
        client_b = TestClient(app, client=("192.168.1.40", 50000))

        create_res = client_a.post("/api/rooms")
        code = create_res.json()["room_code"]

        # First 30 lookups from client_a should succeed
        for _ in range(REST_RATE_LIMIT_CHECK_ROOM_PER_MIN):
            res = client_a.get(f"/api/rooms/{code}")
            self.assertEqual(res.status_code, 200)

        # 31st lookup from client_a should be rate limited
        limited_res = client_a.get(f"/api/rooms/{code}")
        self.assertEqual(limited_res.status_code, 429)
        self.assertIn("retry-after", limited_res.headers)
        retry_after = int(limited_res.headers["retry-after"])
        self.assertGreater(retry_after, 0)
        self.assertIn("Too many room lookup requests", limited_res.json()["detail"])

        # client_b with a different IP should not be blocked
        client_b_res = client_b.get(f"/api/rooms/{code}")
        self.assertEqual(client_b_res.status_code, 200)


if __name__ == "__main__":
    unittest.main()
