"""Unit tests for in-memory RoomManager service."""

import asyncio
import time
import unittest

from app.config import ROOM_CODE_LENGTH, ROOM_CODE_PREFIX
from app.services.room_manager import (
    UNAMBIGUOUS_ALPHABET,
    InvalidRoomCapacityError,
    InvalidRoomCodeError,
    RoomExpiredError,
    RoomFullError,
    RoomManager,
    RoomNotFoundError,
    generate_unambiguous_code,
    normalize_room_code,
)


class TestRoomManager(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self) -> None:
        self.manager = RoomManager(default_ttl=2.0)  # 2 second TTL for tests

    def test_unambiguous_code_generation(self) -> None:
        code = generate_unambiguous_code()
        self.assertTrue(code.startswith(ROOM_CODE_PREFIX))
        self.assertEqual(len(code), len(ROOM_CODE_PREFIX) + ROOM_CODE_LENGTH)
        # Suffix must match configured length
        suffix = code[len(ROOM_CODE_PREFIX):]
        self.assertEqual(len(suffix), ROOM_CODE_LENGTH)
        # Verify characters belong to configured UNAMBIGUOUS_ALPHABET
        for char in suffix:
            self.assertIn(char, UNAMBIGUOUS_ALPHABET)
        # Verify no ambiguous characters (0, O, 1, I, L)
        for bad_char in ["0", "O", "1", "I", "L"]:
            self.assertNotIn(bad_char, suffix)

    def test_unambiguous_code_uniqueness_sample(self) -> None:
        sample_size = 100
        codes = {generate_unambiguous_code() for _ in range(sample_size)}
        self.assertEqual(len(codes), sample_size)

    def test_normalize_room_code(self) -> None:
        # Accepts new 6-character format
        self.assertEqual(normalize_room_code("port-7k2m9x"), "PORT-7K2M9X")
        self.assertEqual(normalize_room_code("PORT-7K2M9X"), "PORT-7K2M9X")
        self.assertEqual(normalize_room_code("7k2m9x"), "PORT-7K2M9X")
        self.assertEqual(normalize_room_code("port7k2m9x"), "PORT-7K2M9X")

        # Preserves backward compatibility for 4-character codes (supported length range 3-8)
        self.assertEqual(normalize_room_code("port-7k2m"), "PORT-7K2M")
        self.assertEqual(normalize_room_code("PORT-7K2M"), "PORT-7K2M")

        with self.assertRaises(InvalidRoomCodeError):
            normalize_room_code("")
        with self.assertRaises(InvalidRoomCodeError):
            normalize_room_code("ab")  # Too short (< 3)
        with self.assertRaises(InvalidRoomCodeError):
            normalize_room_code("A" * 9)  # Too long (> 8)
        with self.assertRaises(InvalidRoomCodeError):
            normalize_room_code("port-7k2m!x")  # Invalid character

    async def test_room_creation(self) -> None:
        room = await self.manager.create_room()
        self.assertTrue(room.code.startswith("PORT-"))
        self.assertEqual(len(room.participants), 0)
        self.assertFalse(room.is_full())
        self.assertTrue(room.is_empty())

        fetched = await self.manager.get_room(room.code)
        self.assertEqual(fetched.code, room.code)

    async def test_create_room_capacity_validation(self) -> None:
        """Verify create_room enforces capacity constraints and prevents partial state."""
        # Omitted uses configured default
        room = await self.manager.create_room()
        self.assertEqual(room.max_participants, self.manager.max_participants_per_room)

        # Valid explicit capacities
        room_2 = await self.manager.create_room(max_participants=2)
        self.assertEqual(room_2.max_participants, 2)

        initial_count = len(self.manager.rooms)

        # Below minimum (< 2)
        with self.assertRaises(InvalidRoomCapacityError):
            await self.manager.create_room(max_participants=1)
        self.assertEqual(len(self.manager.rooms), initial_count)

        # Above maximum (> max_participants_per_room)
        with self.assertRaises(InvalidRoomCapacityError):
            await self.manager.create_room(max_participants=self.manager.max_participants_per_room + 1)
        self.assertEqual(len(self.manager.rooms), initial_count)

    async def test_join_room_host_and_guest(self) -> None:
        room = await self.manager.create_room(max_participants=2)

        # First connection becomes host
        dummy_ws_1 = object()
        room, p1, tok1 = await self.manager.join_room(room.code, dummy_ws_1)
        self.assertEqual(p1.role, "host")
        self.assertTrue(p1.session_id)
        self.assertTrue(tok1)
        self.assertEqual(len(room.participants), 1)
        self.assertFalse(room.is_full())

        # Second connection becomes guest with valid invitation token
        dummy_ws_2 = object()
        room, p2, tok2 = await self.manager.join_room(
            room.code,
            dummy_ws_2,
            invitation_token=room.invitation_token,
        )
        self.assertEqual(p2.role, "guest")
        self.assertNotEqual(p1.session_id, p2.session_id)
        self.assertTrue(tok2)
        self.assertNotEqual(tok1, tok2)
        self.assertEqual(len(room.participants), 2)
        self.assertTrue(room.is_full())

    async def test_join_nonexistent_room(self) -> None:
        with self.assertRaises(RoomNotFoundError):
            await self.manager.join_room("PORT-9999", object())

    async def test_join_full_room_rejected(self) -> None:
        room = await self.manager.create_room(max_participants=2)
        await self.manager.join_room(room.code, object())
        await self.manager.join_room(room.code, object(), invitation_token=room.invitation_token)

        # Third attempt rejected
        with self.assertRaises(RoomFullError):
            await self.manager.join_room(room.code, object(), invitation_token=room.invitation_token)

    async def test_join_multi_participant_room_and_four_limit(self) -> None:
        """Verify 4-participant room accepts 4 participants and rejects a 5th."""
        room = await self.manager.create_room(max_participants=4)
        token = room.invitation_token
        # 1 host
        await self.manager.join_room(room.code, object(), role="host")
        # 3 guests
        for _ in range(3):
            await self.manager.join_room(room.code, object(), invitation_token=token, role="guest")
        self.assertEqual(len(room.participants), 4)
        self.assertTrue(room.is_full())
        self.assertTrue(room.invitation_consumed)

        # 5th attempt rejected with RoomFullError
        with self.assertRaises(RoomFullError):
            await self.manager.join_room(room.code, object(), invitation_token=token, role="guest")

    async def test_leave_room_and_cleanup(self) -> None:
        room = await self.manager.create_room()
        _, p1, _ = await self.manager.join_room(room.code, object())
        _, p2, _ = await self.manager.join_room(room.code, object(), invitation_token=room.invitation_token)

        # Guest leaves
        updated_room, departed, remaining = await self.manager.leave_room(room.code, p2.session_id)
        self.assertIsNotNone(updated_room)
        self.assertEqual(departed.session_id, p2.session_id)
        self.assertEqual(remaining.session_id, p1.session_id)
        self.assertEqual(len(updated_room.participants), 1)

        # Host leaves: room becomes empty and is cleaned up
        empty_room, departed_host, remaining_none = await self.manager.leave_room(room.code, p1.session_id)
        self.assertIsNone(empty_room)
        self.assertEqual(departed_host.session_id, p1.session_id)
        self.assertIsNone(remaining_none)

        # Room no longer exists
        with self.assertRaises(RoomNotFoundError):
            await self.manager.get_room(room.code)

    async def test_room_expiration_and_cleanup(self) -> None:
        # Create room with short TTL
        room = await self.manager.create_room()
        self.manager.rooms[room.code].created_at = time.time() - 10.0  # Expired

        # Getting expired room raises RoomExpiredError and removes it
        with self.assertRaises(RoomExpiredError):
            await self.manager.get_room(room.code)

        # Create another expired room to test batch cleanup
        room2 = await self.manager.create_room()
        self.manager.rooms[room2.code].created_at = time.time() - 10.0

        evicted = await self.manager.cleanup_expired_rooms(ttl=1.0)
        self.assertIn(room2.code, evicted)
        self.assertNotIn(room2.code, self.manager.rooms)


if __name__ == "__main__":
    unittest.main()
