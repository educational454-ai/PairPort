"""REST API endpoints for room management and pre-validation."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.config import MAX_PARTICIPANTS_PER_ROOM, ROOM_TTL_SECONDS
from app.services.room_manager import (
    InvalidRoomCodeError,
    RoomError,
    RoomExpiredError,
    RoomNotFoundError,
    ServerCapacityError,
    normalize_room_code,
    room_manager,
)

router = APIRouter(prefix="/api/rooms", tags=["rooms"])


class CreateRoomResponse(BaseModel):
    room_code: str
    expires_in: int
    max_participants: int = MAX_PARTICIPANTS_PER_ROOM


class RoomInfoResponse(BaseModel):
    room_code: str
    exists: bool
    is_full: bool
    participants_count: int


@router.post("", response_model=CreateRoomResponse, status_code=status.HTTP_201_CREATED)
async def create_room_endpoint() -> CreateRoomResponse:
    """Create a new room in memory and return its generated room code."""
    try:
        room = await room_manager.create_room()
    except ServerCapacityError as err:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(err),
        )
    return CreateRoomResponse(
        room_code=room.code,
        expires_in=ROOM_TTL_SECONDS,
        max_participants=MAX_PARTICIPANTS_PER_ROOM,
    )


@router.get("/stats")
async def get_stats_endpoint() -> dict[str, int]:
    """Return active in-memory room statistics."""
    return room_manager.get_stats()


@router.get("/{room_code}", response_model=RoomInfoResponse)
async def check_room_endpoint(room_code: str) -> RoomInfoResponse:
    """Check if a room exists, is active, and is accepting peers."""
    try:
        room = await room_manager.get_room(room_code)
        return RoomInfoResponse(
            room_code=room.code,
            exists=True,
            is_full=room.is_full(),
            participants_count=len(room.participants),
        )
    except RoomNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Room '{room_code}' was not found.",
        )
    except RoomExpiredError:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail=f"Room '{room_code}' has expired.",
        )
    except InvalidRoomCodeError as err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(err),
        )
