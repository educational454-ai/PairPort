# PairPort — Render Deployment Guide

This guide details how to deploy PairPort's static web client and FastAPI signaling backend to Render's free tier (Static Site + Web Service).

---

## 1. Architectural Overview

```
[ Browser A (Host) ] <==== WebRTC DataChannel (P2P Chat & Files) ====> [ Browser B (Guest) ]
         │                                                                     │
         │ (WSS Signaling)                                   (WSS Signaling)   │
         ▼                                                                     ▼
[ Render Frontend Static Site ]                        [ Render Backend Web Service ]
  Vite / Vanilla JS (dist/)                              FastAPI / Uvicorn (Single Worker)
  https://pairport-frontend.onrender.com                 https://pairport-api.onrender.com
```

- **Frontend**: Render Static Site serving pre-compiled HTML, CSS, and JS assets from `frontend/dist`.
- **Backend**: Render Web Service executing `uvicorn app.main:app` with 1 worker process on `0.0.0.0:$PORT`.
- **Signaling**: WebSocket connection (`wss://pairport-api.onrender.com/ws`) used exclusively for room coordination and WebRTC offer/answer/ICE exchange. Zero chat messages or file bytes are relayed through or stored on the backend.

---

## 2. Option A: Automated Deployment via Blueprint (`render.yaml`)

A root-level [`render.yaml`](render.yaml) is included in this repository.

1. Push your repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), navigate to **Blueprints** → **New Blueprint Instance**.
3. Connect your PairPort repository.
4. Render will detect `render.yaml` and prompt you for the un-synced environment variables:
   - For `PAIRPORT_ALLOWED_ORIGINS`: Provide your anticipated frontend URL (e.g. `https://pairport-frontend.onrender.com`).
   - For `VITE_API_BASE_URL`: Provide your backend URL (e.g. `https://pairport-api.onrender.com`).
   - For `VITE_WS_BASE_URL`: Provide your backend WebSocket URL (e.g. `wss://pairport-api.onrender.com`).
5. Click **Apply**.
6. Once domains are assigned, verify that `PAIRPORT_ALLOWED_ORIGINS` on the backend matches the frontend domain exactly.

---

## 3. Option B: Manual Service Creation in Render Dashboard

If configuring services individually via the Render UI:

### Step 1: Deploy the Backend (FastAPI Web Service)

1. In Render Dashboard, click **New +** → **Web Service**.
2. Select your repository.
3. Configure the following fields:
   - **Name**: `pairport-api`
   - **Region**: Choose the region closest to your users (e.g., `Oregon`, `Frankfurt`).
   - **Root Directory**: `backend`
   - **Runtime**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1`
   - **Instance Type**: `Free`
4. Expand **Advanced** and set **Health Check Path**: `/health`
5. Under **Environment Variables**, add:
   - `PAIRPORT_ENV`: `production`
   - `PAIRPORT_TRUST_PROXY_HEADERS`: `true`
   - `PAIRPORT_WS_REQUIRE_ORIGIN`: `true`
   - `PAIRPORT_ALLOWED_ORIGINS`: Leave temporarily empty or enter your planned frontend domain (e.g. `https://pairport-frontend.onrender.com`).
6. Click **Create Web Service**.
7. Once deployed, copy your backend URL: e.g. `https://pairport-api.onrender.com`.

### Step 2: Deploy the Frontend (Vite Static Site)

1. In Render Dashboard, click **New +** → **Static Site**.
2. Select your repository.
3. Configure the following fields:
   - **Name**: `pairport-frontend`
   - **Branch**: `master` (or your deployment branch)
   - **Root Directory**: `frontend`
   - **Build Command**: `npm install && npm run build`
   - **Publish Directory**: `dist`
4. Expand **Redirects/Rewrites** and add a Single-Page App rewrite:
   - **Type**: `Rewrite`
   - **Source**: `/*`
   - **Destination**: `/index.html`
5. Under **Environment Variables**, configure the build-time backend URLs:
   - `VITE_API_BASE_URL`: `https://pairport-api.onrender.com` (use your actual backend URL)
   - `VITE_WS_BASE_URL`: `wss://pairport-api.onrender.com` (use `wss://` with your backend domain)
6. Click **Create Static Site**.
7. Once deployed, copy your frontend URL: e.g. `https://pairport-frontend.onrender.com`.

### Step 3: Link Allowed Origins in Backend

1. Return to your `pairport-api` Web Service settings in Render.
2. Under **Environment**, update `PAIRPORT_ALLOWED_ORIGINS` to your exact frontend origin:
   ```
   PAIRPORT_ALLOWED_ORIGINS=https://pairport-frontend.onrender.com
   ```
   *(No trailing slash. If you attach a custom domain later, include both separated by a comma: `https://pairport.app,https://pairport-frontend.onrender.com`)*
3. Save changes. The backend will perform a zero-downtime reload.

---

## 4. Operational Considerations & Limitations

> [!WARNING]
> **Free Tier Instance Inactivity (Cold Starts)**:
> Render's free Web Services automatically spin down after 15 minutes of inactivity. When a new room is created or joined after sleeping, the initial WebSocket connection may take 30 to 50 seconds while the container boots. Subsequent connections remain fast while active.

> [!IMPORTANT]
> **In-Memory Signaling & Single-Worker Requirement**:
> - PairPort's room state, guest invitations, and reconnection tokens are stored strictly in Python process memory (`RoomManager`).
> - Uvicorn **must** be executed with `--workers 1`. Running multiple workers without a shared Redis/PubSub backplane will partition rooms across workers, causing peer connection failures.
> - Server restarts, deploys, or sleep cycles will evict existing in-memory rooms. Reconnecting peers will receive a clean disconnect notice.

> [!NOTE]
> **WebRTC NAT Traversal & TURN Requirement**:
> - PairPort uses Google's public STUN servers by default (`stun:stun.l.google.com:19302`).
> - Direct peer-to-peer WebRTC connections will succeed on standard home, office, and Wi-Fi networks.
> - Symmetric NATs (common on cellular 4G/5G mobile networks and strict enterprise firewalls) block direct P2P connections without a TURN relay server.
> - To support restricted networks, configure a TURN provider (e.g., Coturn, Cloudflare Calls, or Twilio) by supplying `VITE_TURN_URLS`, `VITE_TURN_USERNAME`, and `VITE_TURN_CREDENTIAL` in the frontend build environment.

---

## 5. Post-Deployment Verification Checklist

Perform this manual smoke test sequence using two separate browser windows (or one desktop and one mobile device):

- [ ] **1. Backend Health Check**:
  Navigate to `https://pairport-api.onrender.com/health`. Verify it returns HTTP 200 with JSON:
  `{"status":"ok","service":"pairport-api","active_rooms":0,"active_connections":0}`.
- [ ] **2. Frontend Load & Routing**:
  Open `https://pairport-frontend.onrender.com`. Verify the landing page loads cleanly with dark glassmorphic styling and no console errors.
- [ ] **3. Room Creation (Host)**:
  Click **Start Sharing Now** or navigate to `#/pair`. Click **Create Room**. Verify that a 6-character room code (e.g. `PORT-XXXXXX`) is generated and signaling state enters `waiting`.
- [ ] **4. Invitation Link Generation & Redaction**:
  Click **Copy Invite Link**. Verify the clipboard contains `https://pairport-frontend.onrender.com/#join?room=PORT-XXXXXX&token=...`.
- [ ] **5. Guest Pairing & Token Clearance**:
  Open the copied invitation URL in an incognito window or second device. Verify:
  - The URL address bar immediately strips the token fragment to `#/pair`.
  - Both peers transition to `Connected (P2P DataChannel)` and automatically route to `#/workspace`.
- [ ] **6. Ephemeral Chat Exchange**:
  Send messages from both host and guest. Verify messages appear instantly in the chat panel with correct sender alignment and timestamps.
- [ ] **7. Chunked File Transfer**:
  - Drag or browse a file (e.g. 5–20 MB image or zip) into the file drop zone.
  - Verify that the active transfer card displays chunked progress, byte counts, and 100% completion.
  - On the receiving peer, click **Save** and verify the downloaded file is intact.
- [ ] **8. Reconnection Grace Period**:
  Simulate a network blip by toggling network offline on one peer. Verify that the peer displays the 30-second reconnection notice, and upon reconnecting, resumes session activity.
- [ ] **9. Voluntary Leave**:
  Click **Leave Room** on either peer. Verify that both peers return to the Pairing screen and session state is reset.
