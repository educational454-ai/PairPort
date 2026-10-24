# PairPort WebRTC Connectivity, STUN/TURN & Network Resilience Guide

This guide details PairPort's network traversal architecture, STUN and TURN configurations, connection recovery mechanics, diagnostic telemetry, and two-network testing procedures.

---

## 1. STUN vs. TURN in Plain Language

WebRTC allows web browsers to connect directly to each other (Peer-to-Peer, or P2P) to exchange real-time text chat and high-speed binary file transfers without sending payload bytes through a central server. However, most consumer and enterprise devices sit behind Network Address Translation (NAT) firewalls and routers that hide their true public IP addresses.

### STUN (Session Traversal Utilities for NAT)
- **What it does**: A STUN server acts like a public mirror. Your browser contacts the STUN server and asks, *"What is my public IP address and port as seen by the outside Internet?"*
- **Traffic load**: Extremely lightweight. Only a few small UDP packets (~100 bytes) are exchanged during the initial handshake.
- **Limitation**: STUN works when NAT devices allow direct incoming packets from the peer. If both peers are behind **Symmetric NATs** (common on 4G/5G cellular hotspots, corporate networks, and university dorm Wi-Fi), the router assigns a unique random port for every outgoing destination, making direct hole punching impossible.

### TURN (Traversal Using Relays around NAT)
- **What it does**: When direct P2P hole punching fails, a TURN server acts as an authenticated relay. Both browsers connect directly to the public TURN server, and the server forwards the encrypted WebRTC transport packets between them.
- **Traffic load**: Heavy. All WebRTC chat packets and file transfer bytes flow through the TURN relay.
- **Encryption & Privacy**: **TURN relays CANNOT read your data.** WebRTC DataChannels are end-to-end encrypted using DTLS (Datagram Transport Layer Security) and SCTP. The TURN relay merely carries ciphertext.
- **When it is needed**: Whenever direct P2P fails due to symmetric NAT, restrictive outbound firewall rules, or carrier-grade NAT (CGNAT).

---

## 2. Configuration & `.env.example` Usage

PairPort features a single, centralized ICE configuration builder located at:
`frontend/src/config/app-config.js`

### Default STUN Configuration
Out of the box, PairPort defaults to Google's public STUN infrastructure without requiring any configuration:
- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`
- `stun:stun2.l.google.com:19302`

STUN-only mode allows instant local and standard cross-network pairing without running or paying for a relay server.

### Adding Optional TURN Support
To enable TURN relay fallback, configure environment variables in `frontend/.env` (or root `.env`):

```bash
# Comma-separated list of STUN URLs
VITE_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302

# Comma-separated list of TURN/TURNS URLs (supports both UDP and TLS TCP)
VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp

# TURN Authentication Credentials
VITE_TURN_USERNAME=my-test-user
VITE_TURN_CREDENTIAL=my-test-password
```

### Important Security Notice for Client-Side Bundles
> **WARNING**: Any variable prefixed with `VITE_` is compiled directly into the client-side JavaScript bundle during `npm run build` or `npm run dev`. Anyone opening DevTools can extract these credentials.
>
> **For production deployments:**
> - **NEVER** embed permanent admin credentials or shared static passwords into client bundles.
> - **Use Ephemeral Credentials**: Deploy a trusted backend endpoint or use a managed TURN service (e.g. Coturn with REST API, Twilio Network Traversal, Xirsys, Metered, or Cloudflare Calls) that generates short-lived, time-limited HMAC authentication tokens (e.g., valid for 1 hour).

---

## 3. WebRTC Negotiation & Bounded Recovery Mechanics

PairPort implements robust lifecycle handling inside `frontend/src/services/peer-connection.js`:

1. **ICE Candidate Queuing**:
   When network candidates trickle in before `RTCPeerConnection.setRemoteDescription()` has completed, PairPort automatically queues them in `pendingCandidates`. Once the remote description is applied (for both offer and answer), queued candidates are drained in FIFO order. If an individual candidate fails to parse, it is skipped without breaking remaining candidates.

2. **Glare & Collision Protection**:
   Host is designated as the primary offerer. If the host receives an unexpected remote offer while in a non-stable state, it ignores the collision gracefully.

3. **Transient Disconnection Grace Period**:
   When a transient network dip occurs (e.g., phone switching from Wi-Fi to 5G), `iceConnectionState` moves to `'disconnected'`. PairPort sets a 4-second grace period timer. If the link self-heals before the timer expires, no interruption occurs.

4. **Bounded ICE Restart**:
   If the connection transitions to `'failed'`, or remains disconnected after the grace period:
   - PairPort initiates a bounded ICE restart (`pc.restartIce()` and offer with `{ iceRestart: true }`).
   - The host emits `reconnecting` (Attempt X of 3).
   - In-flight file transfers are paused safely.
   - If 3 restart attempts fail, PairPort transitions to the terminal `FAILED` state, informs the user, and releases all buffer resources. **Endless reconnect loops are prevented.**

5. **Resource Cleanup**:
   On room exit or teardown (`close()`), all timers, candidate queues, listeners, peer connections, and object URLs (`URL.revokeObjectURL`) are freed to prevent memory leaks.

---

## 4. Connection Diagnostics UI

PairPort includes an accessible, compact **Connection Diagnostics & ICE Telemetry** drawer inside the Live Session panel.

### Monitored Telemetry
- **Connection Mode**: Displays whether traffic flows directly (`Direct P2P`) or via a relay (`Relayed (TURN Transport)`).
- **ICE Connection State**: `NEW`, `CHECKING`, `CONNECTED`, `COMPLETED`, `DISCONNECTED`, `FAILED`, `CLOSED`.
- **ICE Gathering State**: `NEW`, `GATHERING`, `COMPLETE`.
- **Selected Candidate Type**:
  - `Host (Local LAN)`: Connected directly over the same local network subnet.
  - `Reflexive (STUN NAT)`: Direct P2P connection traversing public Internet routers via STUN hole punching.
  - `Relay (TURN)`: Relayed through an encrypted TURN transport server.
- **Reconnection Retries**: Displays current attempt count (e.g., `0 / 3`).
- **Round-Trip Latency (RTT)**: Extracted from `RTCPeerConnection.getStats()` in milliseconds.
- **Privacy Shield**: All private LAN IP addresses, candidate IPs, ports, and credentials are strictly masked from the UI.

---

## 5. Manual Two-Network Testing Plan

Automated test suites mock browser WebRTC objects. To perform real-world cross-network verification:

### Setup
1. **Device A (Host)**: Connected to Home/Office Wi-Fi.
2. **Device B (Guest)**: Connected to a Mobile 4G/5G Hotspot (completely different network and public IP).

### Test Matrix

| Test Scenario | Steps | Expected Result |
| :--- | :--- | :--- |
| **1. STUN Direct Traversal** | Host creates room, Guest joins from hotspot using default STUN. | Connected directly (`Direct P2P`). Diagnostics shows candidate type `srflx`. Chat and file transfers stream normally. |
| **2. Transient Network Handoff** | While chat is open, toggle Device B from Wi-Fi to cellular data. | Status pill briefly shows yellow `Reconnecting (Attempt 1/3)`. PairPort attempts ICE restart. Link recovers and status returns to green `Connected`. |
| **3. Symmetric NAT / Restrictive Firewall (TURN Verification)** | Connect both devices on restrictive enterprise or university networks where STUN fails. Configure valid TURN in `.env`. | PairPort negotiates a `relay` candidate pair. Status displays purple `TURN Relay: Peer Connected`. Diagnostics shows `Relayed (TURN Transport)`. |
| **4. Unrecoverable Disconnect** | Disable network entirely on Device B (Airplane mode). | Device A enters reconnecting mode. After 3 bounded attempts, status displays red `Connection Failed (Retries exhausted)`. File transfers fail gracefully without hanging. |

---

## 6. Automated Tests vs. Cross-Network Verification

- **Automated Tests (`npm test` and `pytest`)**:
  - Run in headless Node.js and Python test runners.
  - Validate state machine logic, boundary limits, packet packing fidelity, candidate queueing order, retry bounds, and input sanitization.
  - **Do NOT prove cross-network physical NAT traversal.**
- **Manual Two-Network Verification**:
  - Validates actual UDP hole punching, firewall behavior, and TURN relay bandwidth under real ISP conditions.
