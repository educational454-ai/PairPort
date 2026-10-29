# PairPort

**Connect directly. Share freely.**

PairPort is a modern peer-to-peer web application for ephemeral chat and chunked file sharing directly between browsers. It features short-code pairing, zero-storage signaling, end-to-end encrypted WebRTC DataChannels, a multi-participant mesh topology, robust STUN/TURN traversal, live network topology visualization, and an in-app **Network Lab** for real-time protocol and packet inspection.

---

## Current Architecture & Highlights

PairPort operates entirely peer-to-peer for all message and file payloads:

- **Zero Cloud Storage**: Chat messages and file bytes stream directly peer-to-peer over DTLS-encrypted WebRTC DataChannels. The FastAPI signaling server relays room pairing, SDP offers/answers, and ICE candidates only.
- **Multi-Participant Mesh Topology**: Dynamic full mesh supporting up to 4 devices (1 local host/guest + up to 3 remote peers) with deterministic initiator negotiation and live SVG topology visualization.
- **Multi-Recipient File Transfer**: Independent chunked streaming per recipient, 100 MiB file support, 16 KiB–256 KiB chunk streaming, binary packing with 36-byte framing headers, backpressure flow control, SHA-256 chunk counting, and independent recipient cancellation.
- **Configurable ICE Traversal**: Reputable default STUN configuration (Google STUN) with optional TURN/TURNS relay support via environment variables.
- **Bounded ICE Recovery**: Automatic recovery from transient network dips, idempotent bounded ICE restarts (max 3 attempts), and terminal failure handling without infinite loops.
- **Network Lab & Traffic Inspector**: In-app inspection of real PairPort application frames, transfer chunk headers, WebRTC transport telemetry (`getStats()`), privacy-bounded hex viewing, and an external Wireshark packet capture workflow.

---

## Network Lab — Protocol & Traffic Inspection

PairPort includes a dedicated **Network Lab** diagnostics console designed to help developers and users understand what happens when data travels between browsers.

### Key Inspection Features

1. **Live Activity Timeline**:
   - Real-time logging of application-level events (chat queued/accepted, file transfer initialization, chunk frames, transfer completion, WebRTC state changes).
   - Category filtering (`All`, `Chat`, `Files`, `WebRTC`, `Stats`).
   - In-memory circular buffer capped at 500 records; history can be purged at any time without disrupting active transfers or connections.
2. **Selected Event Inspector**:
   - Inspects application-level byte boundaries and framing metadata.
   - For file chunks, displays the verified **36-byte framing header**:
     - Bytes `[0..31]`: 32-byte zero-padded transfer identifier.
     - Bytes `[32..35]`: 32-bit big-endian chunk index.
     - Bytes `[36..]`: Chunk binary payload slice.
   - Distinguishes chunk payload size, application frame size (`36 + chunk`), original file size, and wire network packet size.
3. **Payload Inspection & Privacy Controls**:
   - **Default Bounded Hex View**: Payloads default to a bounded 64-byte hexadecimal preview in Wireshark-style offset and ASCII format (`0000: 48 65 6c ... |Hello...|`).
   - **Explicit User Action to Reveal**: Readable text is hidden by default. Users must click **Reveal Readable Content** to view verified decoded text.
   - **Binary Safety**: Non-text binary file chunks display a clear warning and are never automatically decoded as text or reconstructed into full files in memory.
   - **Zero Secret Logging**: Invitation tokens, reconnect credentials, room secrets, and raw IP addresses are strictly excluded from diagnostics.
4. **Live WebRTC Statistics**:
   - Periodic non-overlapping polling of `RTCPeerConnection.getStats()` every ~1.5s while Network Lab is open.
   - Per-peer statistics: connection state, ICE state, candidate path (`host`, `srflx`, `relay`), round-trip latency (RTT), DTLS cipher suite, and browser-reported cumulative bytes/packets.
   - Derivative throughput estimation calculated strictly from valid consecutive samples with positive elapsed time (`dt > 0.2s`).
   - Zero fabrication: missing or unsupported browser fields are clearly labeled `Unavailable` or `Not exposed by this browser` rather than substituting fake zeros.
5. **Layer Distinction Principle**:
   - A visible distinction banner clarifies:
     > *"Application events show data handled by PairPort. WebRTC statistics are reported by the browser. Network packets are captured externally on the wire. These views describe different layers and may not correspond one-to-one."*

### External Wireshark Capture Guide

Because browser JavaScript cannot observe raw Ethernet/IP/UDP packets or decrypt wire DTLS frames, PairPort includes a Windows-oriented packet capture guide:

- **[docs/NETWORK_LAB_PACKET_CAPTURE.md](docs/NETWORK_LAB_PACKET_CAPTURE.md)**:
  - Step-by-step Npcap adapter selection (LAN Wi-Fi/Ethernet vs. Npcap Loopback for same-machine testing).
  - Capture filters (`udp`) and display filters (`stun || dtls || sctp`).
  - Analysis of Path MTU segmentation (why a single 256 KB application chunk produces ~200 UDP wire packets).
  - WebRTC DTLS end-to-end encryption realities and metadata correlation techniques.
  - Privacy safeguards when capturing network traffic.

For the full architectural source audit and phased implementation specification, see **[docs/NETWORK_LAB_IMPLEMENTATION_PLAN.md](docs/NETWORK_LAB_IMPLEMENTATION_PLAN.md)**.

---

## Project Structure

```
PairPort/
├── docs/
│   ├── NETWORK_LAB_IMPLEMENTATION_PLAN.md  # Architectural source audit & implementation plan
│   ├── NETWORK_LAB_PACKET_CAPTURE.md       # External Wireshark packet capture workflow
│   └── webrtc-turn-guide.md                # Comprehensive STUN/TURN & test plan guide
├── frontend/                               # Vanilla JavaScript + Vite frontend
│   ├── src/
│   │   ├── app.js                          # Master application wiring & view management
│   │   ├── config/app-config.js            # Centralized ICE & STUN/TURN configuration builder
│   │   ├── components/                     # Reusable UI components (icons, modal)
│   │   ├── features/
│   │   │   ├── chat/                       # Ephemeral P2P DataChannel chat
│   │   │   ├── connection/                 # Connection diagnostics & session status
│   │   │   ├── files/                      # Multi-recipient chunked file transfer hub
│   │   │   ├── layout/                     # Navbar, Hero, Features, Footer
│   │   │   ├── network-lab/                # Network Lab UI, inspector & controller
│   │   │   ├── pairing/                    # Room creation & joining workflows
│   │   │   └── topology/                   # Live mesh SVG network visualization
│   │   ├── services/
│   │   │   ├── network-lab.js              # Network Lab event bus, hex bounding & getStats polling
│   │   │   ├── peer-connection.js          # WebRTC PeerConnection, 36B framing & data channels
│   │   │   ├── peer-registry.js            # Multi-peer mesh manager (up to 4 participants)
│   │   │   ├── router.js                   # Client-side hash routing
│   │   │   └── signaling.js                # WebSocket signaling client
│   │   ├── state/app-state.js              # Centralized application state container
│   │   ├── styles/main.css                 # Dark charcoal/violet design system
│   │   └── utils/ui-helpers.js             # Formatters, sanitization & XSS protection
│   └── tests/                              # Frontend unit test suites (353 tests across 100 suites)
│       ├── chat.test.mjs
│       ├── file-transfer.test.mjs
│       ├── multi-recipient-files.test.mjs
│       ├── network-lab.test.mjs
│       ├── peer-registry.test.mjs
│       ├── topology.test.mjs
│       └── ...
└── backend/                                # FastAPI WebSocket signaling backend
    ├── app/
    │   ├── main.py                         # FastAPI application entrypoint
    │   ├── config.py                       # Allowed origins & server configuration
    │   ├── api/
    │   │   ├── rooms.py                    # REST room check & rate limits
    │   │   └── websocket.py                # WebRTC signaling relay & room pairing
    │   └── services/
    │       ├── rate_limiter.py             # IP & token rate limiting
    │       ├── reconnect_manager.py        # Host takeover & reconnect credentials
    │       └── room_manager.py             # In-memory room mesh coordination
    └── tests/                              # Backend pytest suites (124 tests)
        ├── test_multi_participant_signaling.py
        ├── test_room_reconnection.py
        ├── test_rooms_api.py
        ├── test_signaling_websocket.py
        ├── test_webrtc_signaling.py
        ├── test_websocket_origin_security.py
        └── test_websocket_rate_limiting.py
```

---

## Running Locally

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

## Verification & Testing

### Frontend Test Suite
Runs all 353 unit tests across 100 suites covering Network Lab, multi-recipient file sharing, mesh topology, STUN/TURN parsing, candidate queueing, bounded ICE recovery, teardown cleanup, 36-byte chunk packing, and XSS sanitization:

```bash
cd frontend
npm test
```

### Frontend Production Build
Validates that the production bundle builds without errors:

```bash
cd frontend
npm run build
```

### Backend Test Suite
Runs all 124 pytest tests covering room creation, signaling protocols, multi-participant routing, rate limiting, origin security, ICE candidate relay, and rejection of chat/file bytes on signaling:

```bash
cd backend
python -m pytest -v
```

### Whitespace & Hygiene Check
```bash
git diff --check
```
