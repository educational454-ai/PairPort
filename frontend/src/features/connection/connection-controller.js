/**
 * PairPort Connection & Diagnostics Controller
 * Coordinates WebRTC peer connection lifecycle, signaling events, diagnostics, and leave confirmation.
 */

import { showToast } from '../../components/toast.js';
import { showConfirmDialog } from '../../components/modal.js';
import { signalingClient, SIGNALING_STATES } from '../../services/signaling.js';
import {
  peerConnectionService,
  PEER_CONNECTION_STATES,
  DATA_CHANNEL_STATES,
} from '../../services/peer-connection.js';
import { state, resetSessionState } from '../../state/app-state.js';
import { formatTime } from '../../utils/ui-helpers.js';
import { copyInvitationToClipboard } from '../../utils/invitation.js';
import { updateSessionStatusUI } from './session-panel.js';
import { updatePairingCardsUI, setPairingFeedback } from '../pairing/index.js';

/**
 * Bind DOM events inside the active live session panel (leave button, copy code, diagnostics toggle).
 *
 * @param {HTMLElement} root - Root container
 * @param {object} [options]
 * @param {Function} [options.onLeaveRoom] - Callback executed upon confirmed room leave
 * @param {Function} [options.toast=showToast] - Toast notification function
 */
export function bindSessionPanelEvents(root, { onLeaveRoom, toast = showToast } = {}) {
  if (!root) return;

  // 1. Diagnostics drawer toggle (persist open/closed state across re-renders)
  const drawer = root.querySelector('#webrtc-diagnostics-drawer');
  if (drawer) {
    drawer.addEventListener('toggle', () => {
      state.isDiagnosticsOpen = drawer.open;
    });
  }

  // 2. Leave Room button with accessible confirmation dialog
  const leaveBtn = root.querySelector('#leave-room-btn');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', () => {
      showConfirmDialog({
        title: 'Leave Current Room?',
        message: `Disconnect from room "${state.realRoomCode || ''}"? WebRTC data channels will close and your direct peer connection will end.`,
        confirmText: 'Leave Room',
        cancelText: 'Stay in Room',
        isDestructive: true,
        onConfirm: () => {
          if (typeof onLeaveRoom === 'function') {
            onLeaveRoom();
          }
        },
      });
    });
  }

  // 3. Copy live active room code button
  const copyLiveBtn = root.querySelector('#copy-live-code-btn');
  if (copyLiveBtn && state.realRoomCode) {
    copyLiveBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(state.realRoomCode);
        }
        toast(`Copied room code "${state.realRoomCode}"!`, 'success', 3000);
        const textSpan = copyLiveBtn.querySelector('.copy-live-text');
        if (textSpan) {
          const orig = textSpan.textContent;
          textSpan.textContent = 'Copied! ✓';
          copyLiveBtn.classList.add('copied');
          setTimeout(() => {
            textSpan.textContent = orig;
            copyLiveBtn.classList.remove('copied');
          }, 2000);
        }
      } catch {
        toast(`Room code: ${state.realRoomCode}`, 'info', 3000);
      }
    });
  }

  // 4. Copy live secure invitation link button
  const copyLiveInviteBtn = root.querySelector('#copy-live-invite-btn');
  const fallbackBoxEl = root.querySelector('#invitation-fallback-box');
  const fallbackInputEl = root.querySelector('#fallback-invite-input');
  if (copyLiveInviteBtn) {
    copyLiveInviteBtn.addEventListener('click', async () => {
      if (!state.realRoomCode || !state.invitationToken) return;
      await copyInvitationToClipboard(state.realRoomCode, state.invitationToken, {
        toast,
        fallbackBoxEl,
        fallbackInputEl,
        buttonEl: copyLiveInviteBtn,
      });
    });
  }
}

/**
 * Initialize connection event listeners and coordination.
 * Connects signaling client and WebRTC peer connection events to UI state updates.
 *
 * @param {HTMLElement} root - Root container
 * @param {object} [options]
 * @param {Function} [options.onSessionUIUpdate] - Session UI update callback
 * @param {Function} [options.onChatUIUpdate] - Chat UI update callback
 * @param {Function} [options.onFilesUIUpdate] - Files UI update callback
 * @param {object} [options.signaling=signalingClient] - Signaling client service
 * @param {object} [options.peerConnection=peerConnectionService] - WebRTC peer connection service
 * @param {Function} [options.toast=showToast] - Toast notification function
 * @returns {object} Controller API methods
 */
export function initConnectionController(root = document, {
  onSessionUIUpdate,
  onChatUIUpdate,
  onFilesUIUpdate,
  signaling = signalingClient,
  peerConnection = peerConnectionService,
  toast = showToast,
} = {}) {
  // Prevent duplicate registration on same root
  const rootTarget = root && root.nodeType === 9 ? root.documentElement : root;
  if (rootTarget && rootTarget.dataset) {
    if (rootTarget.dataset.connectionControllerInitialized === 'true') {
      return { refreshSessionUI, handleLeave };
    }
    rootTarget.dataset.connectionControllerInitialized = 'true';
  } else if (root && root._connectionControllerInitialized) {
    return { refreshSessionUI, handleLeave };
  } else if (root) {
    root._connectionControllerInitialized = true;
  }

  let peerDisconnectTimer = null;

  function refreshSessionUI() {
    updateSessionStatusUI(root, state);
    bindSessionPanelEvents(root, {
      onLeaveRoom: handleLeave,
      toast,
    });
    updatePairingCardsUI(root, state);
    if (typeof onSessionUIUpdate === 'function') {
      onSessionUIUpdate();
    }
  }

  function handleLeave() {
    // Revoke any in-memory blob URLs
    state.realFiles.forEach((f) => {
      if (f.blobUrl) {
        try { URL.revokeObjectURL(f.blobUrl); } catch {}
        f.blobUrl = null;
      }
    });

    peerConnection.close();
    signaling.leaveRoom();

    if (peerDisconnectTimer) {
      clearInterval(peerDisconnectTimer);
      peerDisconnectTimer = null;
    }

    resetSessionState(state);

    refreshSessionUI();
    if (typeof onChatUIUpdate === 'function') onChatUIUpdate();
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
    toast('Left room session. Returned to pairing view.', 'info', 3000);
  }

  // ----------------------------------------------------
  // Signaling Relay Event Subscriptions
  // ----------------------------------------------------
  signaling.on('stateChange', (newState, detail) => {
    state.signalingState = newState;
    state.realRoomCode = detail.roomCode || state.realRoomCode;
    state.realSessionId = detail.sessionId || state.realSessionId;
    state.realRole = detail.role || state.realRole;
    state.peerSessionId = detail.peerSessionId;

    if (newState === SIGNALING_STATES.ERROR) {
      state.signalingError = detail.message || 'Signaling error occurred.';
    } else {
      state.signalingError = null;
    }

    refreshSessionUI();
  });

  signaling.on('roomCreated', (payload) => {
    state.realRoomCode = payload.room_code;
    state.realSessionId = payload.session_id;
    state.realRole = payload.role;
    state.reconnectToken = payload.reconnect_token || null;
    state.invitationToken = payload.invitation_token || null;
    state.invitationRoomCode = payload.room_code || null;
    toast(`Real room "${payload.room_code}" created on server!`, 'success');
  });

  signaling.on('waiting', () => {
    signaling._pendingJoin = null;
    toast(`Waiting for peer to join room ${state.realRoomCode || ''}`, 'info', 3000);
  });

  signaling.on('peerJoined', async (payload) => {
    signaling._pendingJoin = null;
    state.realRoomCode = payload.room_code;
    state.peerSessionId = payload.peer_session_id;
    if (payload.reconnect_token) {
      state.reconnectToken = payload.reconnect_token;
    }
    toast(`Peer connected to signaling room ${payload.room_code}. Initializing WebRTC...`, 'info', 3000);

    // Both peers present: initiate WebRTC peer connection
    try {
      await peerConnection.startPeerConnection(state.realRole);
    } catch (err) {
      console.error('WebRTC start error:', err);
      toast('Failed to start WebRTC peer connection.', 'warning');
    }
  });

  signaling.on('reconnecting', (info) => {
    state.isSignalingReconnecting = true;
    state.signalingReconnectAttempt = info.attempt || 1;
    refreshSessionUI();
    if (info.attempt === 1) {
      toast('Signaling connection lost. Reconnecting to room...', 'warning', 3000);
    }
  });

  signaling.on('reconnected', async (payload) => {
    state.isSignalingReconnecting = false;
    state.signalingReconnectAttempt = 0;
    state.realRoomCode = payload.room_code || state.realRoomCode;
    state.realSessionId = payload.session_id || state.realSessionId;
    state.realRole = payload.role || state.realRole;
    state.reconnectToken = payload.reconnect_token;
    state.peerSessionId = payload.peer_session_id || null;

    // Attempt WebRTC recovery if peer is present and data channel is not open
    if (payload.peer_session_id && !peerConnection.isChatReady()) {
      if (peerConnection.pc && peerConnection.pc.connectionState !== 'closed') {
        peerConnection.attemptIceRestart('Signaling reconnected');
      } else if (state.realRole === 'host') {
        try {
          await peerConnection.startPeerConnection('host');
        } catch (err) {
          console.error('WebRTC restart error on reconnected:', err);
        }
      }
    }

    refreshSessionUI();
    if (typeof onChatUIUpdate === 'function') onChatUIUpdate();
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
    toast('Reconnected to signaling room!', 'success', 3000);
  });

  signaling.on('peerDisconnected', (payload) => {
    state.isPeerDisconnected = true;
    const grace = Number(payload.grace_period) || 30.0;
    state.peerDisconnectGracePeriod = grace;
    state.peerDisconnectDeadline = Date.now() + (grace * 1000);

    if (peerDisconnectTimer) {
      clearInterval(peerDisconnectTimer);
    }
    peerDisconnectTimer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((state.peerDisconnectDeadline - Date.now()) / 1000));
      if (remaining <= 0) {
        clearInterval(peerDisconnectTimer);
        peerDisconnectTimer = null;
      }
      refreshSessionUI();
    }, 1000);

    state.realChatMessages.push({
      id: `sys-peer-dc-${Date.now()}`,
      sender: 'system',
      text: `Peer disconnected unexpectedly. Slot reserved for ${Math.round(grace)}s reconnect grace period...`,
      timestamp: formatTime(new Date()),
      isReal: true,
    });

    refreshSessionUI();
    if (typeof onChatUIUpdate === 'function') onChatUIUpdate();
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
    toast(`Peer disconnected temporarily. Waiting up to ${Math.round(grace)}s for reconnect...`, 'warning', 4000);
  });

  signaling.on('peerReconnected', async (payload) => {
    if (peerDisconnectTimer) {
      clearInterval(peerDisconnectTimer);
      peerDisconnectTimer = null;
    }
    state.isPeerDisconnected = false;
    state.peerDisconnectGracePeriod = null;
    state.peerDisconnectDeadline = null;
    state.peerSessionId = payload.peer_session_id || state.peerSessionId;

    state.realChatMessages.push({
      id: `sys-peer-rc-${Date.now()}`,
      sender: 'system',
      text: 'Peer reconnected to room! Restoring WebRTC connection...',
      timestamp: formatTime(new Date()),
      isReal: true,
    });

    if (!peerConnection.isChatReady()) {
      if (peerConnection.pc && peerConnection.pc.connectionState !== 'closed') {
        peerConnection.attemptIceRestart('Peer reconnected');
      } else if (state.realRole === 'host') {
        try {
          await peerConnection.startPeerConnection('host');
        } catch (err) {
          console.error('WebRTC restart error on peerReconnected:', err);
        }
      }
    }

    refreshSessionUI();
    if (typeof onChatUIUpdate === 'function') onChatUIUpdate();
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
    toast('Peer reconnected to signaling room!', 'info', 3000);
  });

  signaling.on('reconnectFailed', (payload) => {
    state.isSignalingReconnecting = false;
    state.signalingReconnectAttempt = 0;
    state.reconnectToken = null;
    if (peerDisconnectTimer) {
      clearInterval(peerDisconnectTimer);
      peerDisconnectTimer = null;
    }
    state.isPeerDisconnected = false;
    state.peerDisconnectGracePeriod = null;
    state.peerDisconnectDeadline = null;
    refreshSessionUI();
    toast(`Reconnection failed: ${payload.message || 'Attempts exhausted.'}`, 'error', 5000);
  });

  signaling.on('peerLeft', () => {
    if (peerDisconnectTimer) {
      clearInterval(peerDisconnectTimer);
      peerDisconnectTimer = null;
    }
    state.isPeerDisconnected = false;
    state.peerDisconnectGracePeriod = null;
    state.peerDisconnectDeadline = null;
    state.peerSessionId = null;
    peerConnection.close();

    state.realFiles.forEach((f) => {
      if (f.blobUrl) {
        try { URL.revokeObjectURL(f.blobUrl); } catch {}
        f.blobUrl = null;
      }
    });

    state.realFiles = [];
    state.activeTransfer = null;
    state.fileChannelState = DATA_CHANNEL_STATES.IDLE;

    state.realChatMessages.push({
      id: `sys-${Date.now()}`,
      sender: 'system',
      text: 'Peer left the session. WebRTC DataChannels closed. Waiting for a new peer...',
      timestamp: formatTime(new Date()),
      isReal: true,
    });

    refreshSessionUI();
    if (typeof onChatUIUpdate === 'function') onChatUIUpdate();
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
    toast('Peer left the room.', 'warning', 4000);
  });

  signaling.on('error', (payload) => {
    let errorMsg = payload.message || 'Failed to connect to room.';
    if (payload.code === 'INVITATION_ALREADY_USED') {
      errorMsg = 'This invitation token has already been consumed. A fresh invitation from the host is required.';
    } else if (payload.code === 'INVITATION_REQUIRED') {
      errorMsg = 'An invitation token or valid invite link is required to join this room.';
    } else if (payload.code === 'INVALID_INVITATION') {
      errorMsg = 'The invitation token is invalid for this room.';
    } else if (payload.code === 'INVITATION_EXPIRED') {
      errorMsg = 'This invitation token has expired. Request a new invitation from the host.';
    }

    const isInvitationError = [
      'INVITATION_ALREADY_USED',
      'INVITATION_REQUIRED',
      'INVALID_INVITATION',
      'INVITATION_EXPIRED',
    ].includes(payload.code);

    const pending = signaling._pendingJoin;
    if (pending) {
      // If we had a pending join attempt, only clear if current state still holds the token/room from that attempt.
      // A delayed error from an older attempt must NOT erase a newly captured token/room binding.
      const pendingRoom = pending.roomCode || pending.code;
      const matchesStateToken = !pending.token || state.invitationToken === pending.token;
      const matchesStateRoom = !pendingRoom || state.invitationRoomCode === pendingRoom;
      if (matchesStateToken && matchesStateRoom) {
        state.invitationToken = null;
        state.invitationRoomCode = null;
      }

      const matchesSigToken = !pending.token || signaling.invitationToken === pending.token;
      const matchesSigRoom = !pendingRoom || signaling.invitationRoomCode === pendingRoom;
      if (matchesSigToken && matchesSigRoom) {
        signaling.invitationToken = null;
        signaling.invitationRoomCode = null;
      }

      signaling._pendingJoin = null;
    } else if (isInvitationError) {
      state.invitationToken = null;
      state.invitationRoomCode = null;
      signaling.invitationToken = null;
      signaling.invitationRoomCode = null;
    }

    // Ensure a failed join returns the UI to a usable idle state so the user can paste a fresh invitation
    if (state.signalingState !== SIGNALING_STATES.CONNECTED) {
      state.signalingState = SIGNALING_STATES.IDLE;
      signaling.state = SIGNALING_STATES.IDLE;
    }

    setPairingFeedback(root, errorMsg, 'error');
    refreshSessionUI();
    toast(`Error: ${errorMsg}`, 'warning', 5000);
  });

  // ----------------------------------------------------
  // WebRTC PeerConnection Lifecycle Event Subscriptions
  // ----------------------------------------------------
  peerConnection.on('connectionStateChange', (newState) => {
    state.peerConnectionState = newState;
    state.connectionDiagnostics.connectionState = newState;

    if (newState === 'connected') {
      state.isReconnecting = false;
      state.reconnectAttempt = 0;
      peerConnection.emitDiagnosticsUpdate();
      toast('WebRTC peer connection established directly!', 'success', 3000);
    } else if (newState === 'failed') {
      state.isReconnecting = false;
      toast('WebRTC connection failed. A TURN relay server may be required on restricted networks.', 'warning', 5000);
    }
    refreshSessionUI();
    if (typeof onChatUIUpdate === 'function') onChatUIUpdate();
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
  });

  peerConnection.on('iceConnectionStateChange', (iceState) => {
    state.connectionDiagnostics.iceConnectionState = iceState;
    if (iceState === 'connected' || iceState === 'completed') {
      state.isReconnecting = false;
      state.reconnectAttempt = 0;
      peerConnection.emitDiagnosticsUpdate();
    }
    refreshSessionUI();
  });

  peerConnection.on('iceGatheringStateChange', (gatheringState) => {
    state.connectionDiagnostics.iceGatheringState = gatheringState;
    refreshSessionUI();
  });

  peerConnection.on('reconnecting', (info) => {
    state.isReconnecting = true;
    state.reconnectAttempt = info.attempt;
    state.connectionDiagnostics.reconnectAttempts = info.attempt;
    refreshSessionUI();
    if (typeof onChatUIUpdate === 'function') onChatUIUpdate();
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
    toast(`Reconnecting WebRTC link (attempt ${info.attempt}/${info.maxAttempts})... In-flight transfers paused.`, 'warning', 3500);
  });

  peerConnection.on('terminalFailure', () => {
    state.isReconnecting = false;
    state.peerConnectionState = PEER_CONNECTION_STATES.FAILED;
    state.dataChannelState = DATA_CHANNEL_STATES.CLOSED;
    state.fileChannelState = DATA_CHANNEL_STATES.CLOSED;
    refreshSessionUI();
    if (typeof onChatUIUpdate === 'function') onChatUIUpdate();
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
    toast('WebRTC connection failed: Reconnection attempts exhausted. Check firewall or configure TURN relay.', 'error', 6000);
  });

  peerConnection.on('diagnosticsUpdate', (diag) => {
    state.connectionDiagnostics = { ...state.connectionDiagnostics, ...diag };
    refreshSessionUI();
  });

  peerConnection.on('dataChannelStateChange', (newState) => {
    state.dataChannelState = newState;
    if (typeof onChatUIUpdate === 'function') onChatUIUpdate();
    refreshSessionUI();

    if (newState === 'open') {
      state.realChatMessages.push({
        id: `sys-open-${Date.now()}`,
        sender: 'system',
        text: 'Direct WebRTC DataChannel open! Messages stream peer-to-peer.',
        timestamp: formatTime(new Date()),
        isReal: true,
      });
      if (typeof onChatUIUpdate === 'function') onChatUIUpdate();
      toast('WebRTC DataChannel is open! Real-time chat is ready.', 'success', 4000);
    }
  });

  peerConnection.on('fileChannelStateChange', (newState) => {
    state.fileChannelState = newState;
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
    refreshSessionUI();
  });

  peerConnection.on('fileChannelOpen', () => {
    state.fileChannelState = DATA_CHANNEL_STATES.OPEN;
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
    refreshSessionUI();
    toast('WebRTC file streaming data channel ready!', 'success', 3000);
  });

  peerConnection.on('fileChannelClose', () => {
    state.fileChannelState = DATA_CHANNEL_STATES.CLOSED;
    if (typeof onFilesUIUpdate === 'function') onFilesUIUpdate();
    refreshSessionUI();
  });

  peerConnection.on('error', (err) => {
    console.warn('WebRTC error event:', err);
    if (err.message) {
      toast(`WebRTC notice: ${err.message}`, 'warning', 4000);
    }
  });

  // Bind initial session panel events if already active
  bindSessionPanelEvents(root, {
    onLeaveRoom: handleLeave,
    toast,
  });

  return {
    refreshSessionUI,
    handleLeave,
  };
}
