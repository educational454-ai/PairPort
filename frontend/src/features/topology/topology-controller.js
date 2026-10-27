/**
 * PairPort Live Mesh Network Visualization — Controller (Phase 2B)
 *
 * Coordinates event subscriptions, keyboard/click interactions,
 * real-time traffic pulses, and DOM updates for the topology panel.
 */

import { state as appState, resetSessionState } from '../../state/app-state.js';
import { peerRegistry as defaultRegistry } from '../../services/peer-registry.js';
import { signalingClient as defaultSignaling, SIGNALING_STATES } from '../../services/signaling.js';
import {
  computeTopologyGraph,
  renderTopologySvg,
  renderPeerDetailCard,
} from './topology-ui.js';

export function initTopologyPanel(root = document, {
  peerRegistry = defaultRegistry,
  signaling = defaultSignaling,
  state = appState,
} = {}) {
  const panelEl = root.querySelector('#mesh-topology-panel');
  if (!panelEl) {
    return {
      update: () => {},
      selectPeer: () => {},
      destroy: () => {},
      getSelectedPeer: () => null,
    };
  }

  // Prevent duplicate initialization on same root element
  if (panelEl._topoController) {
    try {
      panelEl._topoController.destroy();
    } catch {}
  }

  let selectedPeerId = null;
  let isCollapsed = false;
  const activityMap = new Map();
  const activityTimers = new Map();
  const unsubs = [];

  const canvasHost = panelEl.querySelector('#topo-canvas-host');
  const inspectorHost = panelEl.querySelector('#topo-inspector-host');
  const counterPill = panelEl.querySelector('#topo-counter-pill');
  const toggleBtn = panelEl.querySelector('#topo-toggle-btn');
  const bodyEl = panelEl.querySelector('#topo-panel-body');

  /**
   * Re-render SVG topology and detail inspector based on current state.
   */
  async function update() {
    if (!canvasHost || !inspectorHost) return;

    try {
      const graphData = computeTopologyGraph(state, peerRegistry);

      // Update counter pill
      if (counterPill) {
        const devCount = graphData.totalParticipants;
        const linkCount = graphData.edges.length;
        const linkLabel = linkCount === 1 ? '1 Link' : `${linkCount} Links`;
        counterPill.textContent = `${devCount}/${graphData.maxParticipants} Devices · ${linkLabel}`;
      }

      // Default selection to first remote peer if none selected and peers exist
      if (!selectedPeerId && graphData.remoteNodes.length > 0) {
        selectedPeerId = graphData.remoteNodes[0].id;
      } else if (!selectedPeerId) {
        selectedPeerId = 'local';
      }

      // Render SVG
      canvasHost.innerHTML = renderTopologySvg(graphData, selectedPeerId, activityMap);

      // Render Detail Inspector
      let selectedInfo = null;
      if (selectedPeerId === 'local') {
        let localDiag = state.connectionDiagnostics || {};
        if (peerRegistry && typeof peerRegistry.getConnectionDiagnostics === 'function') {
          try {
            localDiag = await peerRegistry.getConnectionDiagnostics();
          } catch {}
        }
        selectedInfo = {
          isLocal: true,
          id: 'local',
          label: 'Local Device (You)',
          role: peerRegistry?.myRole || state?.realRole || 'host',
          status: graphData.localNode.status,
          diagnostics: localDiag,
        };
      } else {
        const node = graphData.remoteNodes.find((n) => n.id === selectedPeerId);
        if (node) {
          let peerDiag = {};
          if (node.peerService && typeof node.peerService.getConnectionDiagnostics === 'function') {
            try {
              peerDiag = await node.peerService.getConnectionDiagnostics();
            } catch {}
          }
          selectedInfo = {
            isLocal: false,
            id: node.id,
            label: node.label,
            role: node.role,
            status: node.status,
            peerService: node.peerService,
            diagnostics: peerDiag,
          };
        } else {
          selectedPeerId = 'local';
          selectedInfo = {
            isLocal: true,
            id: 'local',
            label: 'Local Device (You)',
            role: peerRegistry?.myRole || state?.realRole || 'host',
            status: graphData.localNode.status,
            diagnostics: state.connectionDiagnostics || {},
          };
        }
      }

      inspectorHost.innerHTML = renderPeerDetailCard(selectedInfo);
    } catch (err) {
      console.warn('[PairPort Topology] Render error:', err);
    }
  }

  function selectPeer(peerId) {
    selectedPeerId = peerId;
    update();
  }

  function handleActivity(event) {
    const peerId = event?.peerSessionId;
    if (!peerId) return;

    activityMap.set(peerId, {
      type: event.type || 'chat',
      direction: event.direction || 'in',
      timestamp: Date.now(),
    });

    if (activityTimers.has(peerId)) {
      clearTimeout(activityTimers.get(peerId));
    }

    const t = setTimeout(() => {
      activityMap.delete(peerId);
      activityTimers.delete(peerId);
      update();
    }, 1200);

    activityTimers.set(peerId, t);
    update();
  }

  // ----------------------------------------------------
  // Interactive Node Selection (Click & Keyboard)
  // ----------------------------------------------------
  function handleCanvasClick(e) {
    const nodeEl = e.target.closest('[data-peer-id]');
    if (nodeEl) {
      const peerId = nodeEl.dataset.peerId;
      if (peerId) {
        selectPeer(peerId);
      }
    }
  }

  function handleCanvasKeydown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      const nodeEl = e.target.closest('[data-peer-id]');
      if (nodeEl) {
        e.preventDefault();
        const peerId = nodeEl.dataset.peerId;
        if (peerId) {
          selectPeer(peerId);
        }
      }
    }
  }

  if (canvasHost) {
    canvasHost.addEventListener('click', handleCanvasClick);
    canvasHost.addEventListener('keydown', handleCanvasKeydown);
  }

  // Collapse / Expand toggle
  function handleToggleClick() {
    isCollapsed = !isCollapsed;
    bodyEl.classList.toggle('hidden', isCollapsed);
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    const toggleText = toggleBtn.querySelector('.topo-toggle-text');
    if (toggleText) {
      toggleText.textContent = isCollapsed ? 'Expand' : 'Collapse';
    }
  }

  if (toggleBtn && bodyEl) {
    toggleBtn.addEventListener('click', handleToggleClick);
  }

  // ----------------------------------------------------
  // Service Event Subscriptions
  // ----------------------------------------------------
  if (peerRegistry && typeof peerRegistry.on === 'function') {
    unsubs.push(peerRegistry.on('peerAdded', () => update()));
    unsubs.push(peerRegistry.on('peerRemoved', (evt) => {
      if (selectedPeerId === evt?.peerSessionId) {
        selectedPeerId = null;
      }
      update();
    }));
    unsubs.push(peerRegistry.on('peerConnectionStateChange', () => update()));
    unsubs.push(peerRegistry.on('peerDataChannelStateChange', () => update()));
    unsubs.push(peerRegistry.on('peerIceStateChange', () => update()));
    unsubs.push(peerRegistry.on('diagnosticsUpdate', () => update()));
    unsubs.push(peerRegistry.on('peerActivity', handleActivity));
    unsubs.push(peerRegistry.on('peerDisconnected', () => update()));
    unsubs.push(peerRegistry.on('peerReconnected', () => update()));
    unsubs.push(peerRegistry.on('connectionStateChange', () => update()));
  }

  if (signaling && typeof signaling.on === 'function') {
    unsubs.push(signaling.on('roomRoster', () => update()));
    unsubs.push(signaling.on('stateChange', (newState) => {
      if (newState === SIGNALING_STATES.IDLE) {
        selectedPeerId = 'local';
        activityTimers.forEach((timer) => clearTimeout(timer));
        activityTimers.clear();
        activityMap.clear();
      }
      update();
    }));
  }

  // Initial draw
  update();

  const controller = {
    update,
    selectPeer,
    getSelectedPeer: () => selectedPeerId,
    destroy: () => {
      unsubs.forEach((unsub) => {
        try { unsub(); } catch {}
      });
      unsubs.length = 0;

      activityTimers.forEach((timer) => clearTimeout(timer));
      activityTimers.clear();
      activityMap.clear();

      if (canvasHost) {
        canvasHost.removeEventListener('click', handleCanvasClick);
        canvasHost.removeEventListener('keydown', handleCanvasKeydown);
      }

      if (toggleBtn && typeof toggleBtn.removeEventListener === 'function') {
        toggleBtn.removeEventListener('click', handleToggleClick);
      }

      if (panelEl) {
        delete panelEl._topoController;
      }
    },
  };

  panelEl._topoController = controller;
  return controller;
}
