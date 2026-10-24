# PairPort

**Connect directly. Share freely.**

PairPort is a modern peer-to-peer web app for ephemeral chat and chunked file sharing directly between browsers. It features short-code pairing, zero-storage signaling, end-to-end encrypted WebRTC DataChannels, robust STUN/TURN traversal, and bounded network recovery.

---

## Current Architecture & Status

PairPort has completed **Phase 6: Reliable WebRTC Connectivity, STUN/TURN & Network Resilience** alongside Phase 5 (P2P File Transfer) and Phase 8 (Product Polish & UX):

- **Zero Cloud Storage**: Chat messages and file bytes stream directly peer-to-peer over DTLS-encrypted WebRTC DataChannels. The FastAPI signaling server relays SDP and ICE candidates only.
- **Configurable ICE Traversal**: Reputable default STUN configuration (Google STUN) with optional TURN/TURNS relay support via environment variables.
- **Bounded ICE Recovery**: Automatic recovery from transient network dips, idempotent bounded ICE restarts (max 3 attempts), and terminal failure handling without infinite loops.
- **Diagnostics & Telemetry**: Built-in, accessible connection diagnostics drawer displaying real-time ICE connection states, candidate types (Host, STUN Reflexive, or TURN Relay), latency (RTT), and reconnect counters while masking private IP addresses.
- **Chunked File Transfer**: 100 MiB file support, 16 KiB chunk streaming, binary packing with 36-byte framing headers, backpressure flow control, SHA-256 chunk counting, and transfer cancellation.

---

## Project Structure

```
PairPort/
├── .env.example                     # Environment configuration reference
├── docs/
│   └── webrtc-turn-guide.md        # Comprehensive STUN/TURN & test plan guide
├── frontend/                        # Vanilla JavaScript + Vite frontend
│   ├── .env.example                # Frontend environment template
│   ├── src/
│   │   ├── app.js                  # Main UI, live session, and diagnostics drawer
│   │   ├── config/app-config.js    # Centralized ICE & STUN/TURN configuration builder
│   │   ├── services/
│   │   │   ├── peer-connection.js  # WebRTC PeerConnection, DataChannels & recovery
│   │   │   └── signaling.js        # WebSocket signaling client
│   │   ├── styles/main.css         # Dark charcoal/violet design system
│   │   └── utils/ui-helpers.js     # Sanitization, formatters & XSS protection
│   └── tests/                      # Frontend unit test suites (62 tests)
│       ├── file-transfer.test.mjs
│       ├── ice-configuration.test.mjs
│       ├── ice-recovery.test.mjs
│       └── ui-helpers.test.mjs
└── backend/                         # FastAPI WebSocket signaling backend
    ├── app/
    │   ├── main.py                 # FastAPI application
    │   ├── api/websocket.py        # WebRTC signaling relay & room pairing
    │   └── services/room_manager.py# In-memory room management
    └── tests/                      # Backend pytest suites (26 tests)
        ├── test_room_manager.py
        ├── test_rooms_api.py
        ├── test_signaling_websocket.py
        └── test_webrtc_signaling.py
```

---

## Getting Started

### Prerequisites
- Node.js 20.19+ or 22.12+
- Python 3.11+
- Modern WebRTC-capable web browser (Chrome, Edge, Firefox, Safari)

### 1. Run the Backend (Signaling Server)

```bash
cd backend
python -m venv .venv

# Activate virtual environment
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# macOS/Linux:
# source .venv/bin/activate

pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Verify backend health at `http://127.0.0.1:8000/health`.

### 2. Run the Frontend (Vite)

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in two separate browser windows (or devices) to pair and test.

---

## Configuring STUN and TURN

PairPort works out of the box in **STUN-only mode** using public Google STUN servers. When two devices cannot connect directly due to restrictive symmetric NATs or firewalls, optional TURN relay servers can be configured via environment variables.

Copy `.env.example` to `frontend/.env`:

```bash
# STUN Servers (comma-separated)
VITE_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302

# Optional TURN Relay Servers (supports turn: and turns:)
VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
VITE_TURN_USERNAME=my-turn-username
VITE_TURN_CREDENTIAL=my-turn-password
```

> **Client Security Notice**: Vite environment variables (`VITE_*`) are bundled into client code and are **not secret**. For production, use an ephemeral credential service (e.g. Coturn REST API, Twilio Network Traversal, or Cloudflare Calls) to generate time-limited HMAC tokens.

For complete deployment details, symptoms of firewall failure, and the manual two-network test plan, see [docs/webrtc-turn-guide.md](docs/webrtc-turn-guide.md).

---

## Verification & Testing

### Frontend Test Suite
Runs all 62 unit tests covering STUN/TURN parsing, candidate queueing/flushing, bounded ICE restart, teardown cleanup, chunk packing, integrity checks, and XSS sanitization:

```bash
cd frontend
npm test
```

### Frontend Production Build
```bash
cd frontend
npm run build
```

### Backend Test Suite
Runs all 26 pytest tests covering room creation, unambiguous code generation, signaling protocol, ICE candidate relay, offer renegotiation, and rejection of chat/file bytes on signaling:

```bash
cd backend
python -m pytest -v
```

### Python Syntax Check
```bash
cd backend
python -m py_compile app/main.py app/config.py app/api/websocket.py app/api/rooms.py app/services/room_manager.py
```
