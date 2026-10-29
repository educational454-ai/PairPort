# PairPort Network Lab — External Packet Capture Guide (Wireshark)

This guide provides practical, step-by-step instructions for capturing and inspecting real PairPort network traffic using [Wireshark](https://www.wireshark.org/) on Windows.

It explains what happens on the physical network when you send chat messages and stream files over WebRTC, how wire packets differ from in-app application chunks, and how to verify transport security.

---

## 1. Prerequisites and Interface Selection

1. **Install Wireshark**: Download and install Wireshark on Windows (including Npcap during installation).
2. **Identify the Active Network Adapter**:
   - Open Wireshark. The welcome screen displays active network interfaces with live traffic sparklines.
   - Select your primary active connection:
     - **Wi-Fi** (e.g. `Wi-Fi` or `Wireless Network Connection`) if testing over local Wi-Fi.
     - **Ethernet** if wired to your local router or switch.
     - **Npcap Loopback Adapter** (`\Device\NPF_Loopback`) **only** if both browser tabs or test peers are running on the exact same physical Windows machine.
     > **Windows Loopback Note:** Ordinary Windows NDIS network drivers do not see traffic between two local processes on `127.0.0.1` unless Npcap's "Support loopback traffic" option is installed and the Npcap Loopback interface is selected.

---

## 2. Capture Workflow

To capture the entire WebRTC handshake and subsequent data exchange:

1. **Prepare PairPort**: Open PairPort in your browser (`http://localhost:5173` or your LAN address), but **do not join a room yet**.
2. **Set a Capture Filter (Optional, Before Starting)**:
   - In Wireshark's capture filter field (green bar above the interface list), you can optionally enter `udp` to filter out background TCP web traffic, or leave it blank to capture all traffic.
   - *Caution:* A broad `udp` capture filter captures DNS, SSDP, mDNS, and other system traffic, so you will use display filters during analysis.
3. **Start Capture**: Double-click your chosen interface or click the blue shark fin icon (**Start capturing packets**).
4. **Initiate PairPort Connection**:
   - Device 1: Click **Create Room** (acts as Host).
   - Device 2: Enter the room code and click **Join Room** (acts as Guest).
   - Wait for WebRTC negotiation to complete (status dot turns green).
5. **Generate Diagnostic Traffic**:
   - Send a recognizable chat message (e.g., `TEST_NETLAB_CHAT_01`).
   - Transfer a small test file (e.g., a 100 KB image or document).
   - In PairPort's **Network Lab**, note the event timestamp (e.g., `14:32:05.142`) to correlate with Wireshark.
6. **Stop Capture**: Click the red square icon (**Stop capturing packets**).
7. **Save the Capture (Optional)**:
   - If you wish to save the session for offline analysis, choose **File → Save As...** and save as `.pcapng`.
   - *Privacy Warning:* Capture files contain raw MAC addresses, local/public IP addresses, port numbers, and unencrypted non-WebRTC background traffic from your machine. Never share raw `.pcapng` files publicly.

---

## 3. Dissecting WebRTC Protocols in Wireshark

WebRTC does not use a single monolithic protocol. It orchestrates several specialized IETF standards across two distinct network paths:

```
+-------------------------------------------------------------------------+
|                           PairPort Architecture                         |
+------------------------------------+------------------------------------+
|       Signaling Path (Server)      |     Peer-to-Peer Data Path (Mesh)  |
|         FastAPI WebSocket          |            WebRTC SCTP             |
+------------------------------------+------------------------------------+
|  • HTTP / WebSocket (Port 8000)    |  • ICE Connectivity (STUN / TURN)  |
|  • Session creation & join         |  • DTLS (Datagram Transport Layer  |
|  • SDP Offer / Answer exchange     |    Security) Handshake             |
|  • ICE candidate exchange          |  • SCTP (Stream Control Trans-    |
|                                    |    mission Protocol) DataChannels  |
|  (Carries ZERO file/chat bytes)    |  (Carries ALL chat & file chunks)  |
+------------------------------------+------------------------------------+
```

### Protocol Breakdown

1. **Signaling (TCP / WebSocket)**:
   - Display Filter: `tcp.port == 8000 || websocket`
   - Shows room creation, SDP exchanges, and ICE candidates routing through the FastAPI server.
   - **Crucial verification:** You will see that file transfer chunks and chat messages are **never** present in the signaling stream.

2. **ICE Connectivity Checks (STUN / TURN)**:
   - Display Filter: `stun || turn`
   - You will see STUN `Binding Request` and `Binding Success Response` packets between peer UDP ports.
   - These packets establish and verify NAT traversal before any application data flows.

3. **Security Handshake (DTLS)**:
   - Display Filter: `dtls`
   - You will see `Client Hello`, `Server Hello`, `Certificate`, `Server Key Exchange`, and `Change Cipher Spec`.
   - DTLS negotiates ephemeral encryption keys directly between browsers using ECDSA/RSA keys generated in memory.

4. **Application Data (SCTP over DTLS over UDP)**:
   - Display Filter: `sctp` or `udp`
   - Once DTLS finishes, WebRTC DataChannels transfer data via SCTP encapsulated inside encrypted DTLS records.
   - In Wireshark, without session keys, these packets appear as **`DTLSv1.2` or `DTLSv1.3 Application Data`**.

---

## 4. Useful Wireshark Display Filters

| Filter Query | Purpose |
| :--- | :--- |
| `stun` | Shows STUN binding requests/responses (ICE candidate validation). |
| `dtls` | Shows the DTLS handshake and encrypted record headers. |
| `sctp` | Shows SCTP packets (if DTLS is unencrypted or decrypted). |
| `udp.port == <port>` | Filters to a specific peer UDP port identified in Network Lab stats. |
| `frame.len > 1000` | Filters for large packets, typically file chunk transfer frames. |
| `stun \|\| dtls` | Focuses specifically on WebRTC peer-to-peer transport traffic. |

---

## 5. Application Chunks vs. Network Packets

A fundamental principle of network engineering is that **application data frames do not equal network packets**:

| Metric | PairPort Application Chunk | Wireshark Wire Packet |
| :--- | :--- | :--- |
| **Layer** | Application Layer (Layer 7) | Link & Network Layers (Layers 2–4) |
| **Composition** | 36-byte PairPort header + file slice | Ethernet + IP + UDP + DTLS + SCTP headers + encrypted ciphertext |
| **Chunk Size** | Configured chunk size (e.g. 256 KB) | Capped by Path MTU (typically 1,200 to 1,500 bytes per packet) |
| **Fragmentation**| Single continuous buffer in JavaScript | SCTP and IP segment chunks across multiple wire packets |
| **Observation**| In-app `networkLabService` observer | Network Interface Card (Npcap driver) |
| **Visibility** | Decoded JSON strings / file byte views | Encrypted binary payload (`Application Data`) |

### Why One 256 KB File Chunk Produces ~200 Wire Packets

When PairPort passes a 256 KB chunk to `RTCDataChannel.send()`, SCTP segments the chunk into messages fitting within the Path MTU (typically ~1,200 bytes of SCTP payload to prevent UDP fragmentation). 

Therefore, a single application chunk produces **over 200 individual UDP packets** on the wire. Wireshark observes the individual network packets; PairPort observes the application frame.

---

## 6. Encryption Realities & Payload Confidentiality

### Why Chat and Files Are Not Readable in Wireshark
WebRTC mandates end-to-end encryption via DTLS (RFC 8826 / RFC 8827):
- All DataChannel SCTP messages are encrypted with ephemeral symmetric keys (e.g. `AES-128-GCM` or `AES-256-GCM`).
- The browser generates these keys in memory for each WebRTC peer connection.
- Unlike HTTPS, where an SSLKEYLOGFILE can be exported by setting an environment variable in Chrome/Firefox, WebRTC DTLS key extraction is intentionally restricted by browsers to prevent eavesdropping on peer communications.

**Expected Wireshark Output:**
When inspecting a packet containing your chat message or file chunk, Wireshark will display:
```
Transport Layer Security
  DTLSv1.2 Record Layer: Application Data Protocol: data
    Content Type: Application Data (23)
    Version: DTLS 1.2 (0xfeef)
    Epoch: 1
    Sequence Number: 42
    Length: 1248
    Encrypted Application Data: 84a9c2... [248 bytes]
```
The raw text and file contents are **completely unreadable** on the wire.

### Correlating Capture with PairPort Network Lab
To correlate a wire capture with PairPort's in-app Network Lab without decrypting payloads:
1. **Timestamp Correlation**: Match the millisecond timestamp in Network Lab (e.g., `14:32:05.142`) with Wireshark's `Time` column.
2. **Cumulative Byte Verification**: Compare the cumulative `bytesSent` in PairPort's WebRTC Statistics table with Wireshark's conversation statistics (`Statistics → Conversations → UDP`). Note that Wireshark's byte total will be slightly larger due to IP (20B), UDP (8B), DTLS (~13B), and SCTP header overhead.
3. **Endpoint Matching**: Match the local and remote UDP ports exposed by your browser in `chrome://webrtc-internals` with the IP/UDP endpoints in Wireshark.

---

## 7. Capture Environment Limitations

- **Same Machine (Loopback)**:
  - If capturing on one PC between two browser tabs, you must select the **Npcap Loopback Adapter**.
  - Local host routing skips standard network card offloading, meaning packet sizes in Wireshark may appear unnaturally large (up to 64 KB) if TCP Large Send Offload (LSO) or UDP segmentation offload is active.
- **Cross-Device (LAN Wi-Fi)**:
  - Wi-Fi adapters in standard mode only capture packets addressed to or from your machine. They will not capture traffic between two other third-party devices on the same Wi-Fi router unless in monitor mode or using a managed network switch with port mirroring (SPAN).
- **VPNs and Virtual Adapters**:
  - If a VPN (e.g., WireGuard, OpenVPN, Cisco AnyConnect) is active, WebRTC traffic may route through a virtual TAP/TUN adapter. Ensure you capture on the virtual adapter or disable the VPN during testing.

---

## 8. Privacy & Security Checklist

- [x] **Mask Sensitive Tokens**: PairPort Network Lab never logs room secrets, reconnect tokens, or invitation URLs.
- [x] **Avoid Capturing Unrelated Traffic**: Close other background downloads, video streams, or messaging apps before starting a capture session.
- [x] **Do Not Distribute Raw Captures**: Treat `.pcapng` files as confidential documents containing your local network topology and device MAC addresses.
