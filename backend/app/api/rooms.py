"""REST API endpoints for room management and pre-validation."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from app.config import (
    MAX_PARTICIPANTS_PER_ROOM,
    REST_RATE_LIMIT_CHECK_ROOM_PER_MIN,
    REST_RATE_LIMIT_CREATE_ROOM_PER_MIN,
    REST_RATE_LIMIT_WINDOW_SECONDS,
    ROOM_TTL_SECONDS,
)
from app.services.rate_limiter import get_client_ip, rest_rate_limiter
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


@router.post("", response_model=CreateRoomResponse, status_code=status.HTTP_201_CREATED)
async def create_room_endpoint(request: Request) -> CreateRoomResponse:
    """Create a new room in memory and return its generated room code."""
    client_ip = get_client_ip(request)
    allowed, retry_after = await rest_rate_limiter.acquire(
        key=f"create:{client_ip}",
        limit=REST_RATE_LIMIT_CREATE_ROOM_PER_MIN,
        window_seconds=REST_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many room creation requests. Please slow down.",
            headers={"Retry-After": str(retry_after)},
        )

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
    """Return active in-memory room statistics.

    NOTE: Left accessible for operational monitoring in this step, as no internal
    authentication subsystem currently exists. Do not expose in sensitive environments.
    """
    return room_manager.get_stats()


@router.get("/{room_code}", response_model=RoomInfoResponse)
async def check_room_endpoint(room_code: str, request: Request) -> RoomInfoResponse:
    """Check if a room exists, is active, and is accepting peers."""
    client_ip = get_client_ip(request)
    allowed, retry_after = await rest_rate_limiter.acquire(
        key=f"check:{client_ip}",
        limit=REST_RATE_LIMIT_CHECK_ROOM_PER_MIN,
        window_seconds=REST_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many room lookup requests. Please slow down.",
            headers={"Retry-After": str(retry_after)},
        )

    try:
        room = await room_manager.get_room(room_code)
        return RoomInfoResponse(
            room_code=room.code,
            exists=True,
            is_full=room.is_full(),
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
