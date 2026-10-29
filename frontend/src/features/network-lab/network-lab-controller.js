/**
 * PairPort Network Lab — Controller (Phase 2)
 *
 * Coordinates event subscriptions, user interactions (filtering, event selection,
 * bounded hex viewing, explicit payload text reveal), and WebRTC stats polling.
 */

import { state as appState } from '../../state/app-state.js';
import { networkLabService, EVENT_CATEGORIES } from '../../services/network-lab.js';
import { peerRegistry as defaultRegistry } from '../../services/peer-registry.js';
import {
  renderTimelineEvents,
  renderEventInspector,
  renderStatsTable,
} from './network-lab-ui.js';

export function initNetworkLabPanel(
  root = document,
  {
    service = networkLabService,
    peerRegistry = defaultRegistry,
    state = appState,
  } = {}
) {
  const panelEl = root.querySelector('#network-lab-panel');
  if (!panelEl) {
    return {
      update: () => {},
      selectEvent: () => {},
      destroy: () => {},
    };
  }

  // Prevent duplicate initialization on same root element
  if (panelEl._netLabController) {
    try {
      panelEl._netLabController.destroy();
    } catch {}
  }

  let activeFilter = 'all';
  let selectedEventId = null;
  let isRevealed = false;
  let isOpen = Boolean(state.isNetworkLabOpen);

  const timelineHost = panelEl.querySelector('#netlab-timeline-host');
  const inspectorHost = panelEl.querySelector('#netlab-inspector-host');
  const statsHost = panelEl.querySelector('#netlab-stats-host');
  const counterPill = panelEl.querySelector('#netlab-event-counter');
  const filteredCountEl = panelEl.querySelector('#netlab-filtered-count');
  const toggleBtn = panelEl.querySelector('#netlab-toggle-btn');
  const clearBtn = panelEl.querySelector('#netlab-clear-btn');
  const bodyEl = panelEl.querySelector('#netlab-panel-body');
  const filterBtns = panelEl.querySelectorAll('.netlab-filter-btn');

  const unsubs = [];

  /**
   * Filter recorded events based on active category.
   */
  function getFilteredEvents() {
    const all = service.getEvents();
    if (activeFilter === 'all') return all;
    if (activeFilter === 'chat') return all.filter((e) => e.category === EVENT_CATEGORIES.CHAT);
    if (activeFilter === 'file') return all.filter((e) => e.category === EVENT_CATEGORIES.FILE);
    if (activeFilter === 'webrtc') return all.filter((e) => e.category === EVENT_CATEGORIES.WEBRTC);
    if (activeFilter === 'stats') return all.filter((e) => e.category === EVENT_CATEGORIES.STATS);
    return all;
  }

  /**
   * Refresh the activity timeline list.
   */
  function refreshTimeline() {
    if (!timelineHost) return;
    const events = getFilteredEvents();
    timelineHost.innerHTML = renderTimelineEvents(events, selectedEventId);

    if (filteredCountEl) {
      filteredCountEl.textContent = `Showing ${events.length} of ${service.getEventCount()}`;
    }
  }

  /**
   * Refresh the selected event inspector panel.
   */
  function refreshInspector() {
    if (!inspectorHost) return;
    const event = selectedEventId ? service.getEventById(selectedEventId) : null;
    inspectorHost.innerHTML = renderEventInspector(event, isRevealed);

    // Bind reveal/hide buttons inside inspector
    const revealBtn = inspectorHost.querySelector('#netlab-reveal-payload-btn');
    if (revealBtn) {
      revealBtn.addEventListener('click', (e) => {
        e.preventDefault();
        isRevealed = true;
        if (selectedEventId) {
          service.setEventRevealed(selectedEventId, true);
        }
        refreshInspector();
      });
    }

    const hideBtn = inspectorHost.querySelector('#netlab-hide-payload-btn');
    if (hideBtn) {
      hideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        isRevealed = false;
        if (selectedEventId) {
          service.setEventRevealed(selectedEventId, false);
        }
        refreshInspector();
      });
    }
  }

  /**
   * Refresh total event count pill in header.
   */
  function refreshCounter() {
    if (!counterPill) return;
    const count = service.getEventCount();
    counterPill.textContent = `${count} ${count === 1 ? 'Event' : 'Events'}`;
  }

  /**
   * Refresh the live stats table.
   */
  function refreshStats(statsMap = null) {
    if (!statsHost) return;
    const map = statsMap || service.getLatestStats();
    statsHost.innerHTML = renderStatsTable(map);
  }

  /**
   * Set open / collapse state of the lab drawer.
   */
  function setPanelOpen(open) {
    isOpen = Boolean(open);
    state.isNetworkLabOpen = isOpen;

    if (bodyEl) {
      if (isOpen) {
        bodyEl.classList.remove('hidden');
        panelEl.classList.add('is-open');
        panelEl.classList.remove('is-collapsed');
      } else {
        bodyEl.classList.add('hidden');
        panelEl.classList.remove('is-open');
        panelEl.classList.add('is-collapsed');
      }
    }

    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', String(isOpen));
      const toggleText = toggleBtn.querySelector('.netlab-toggle-text');
      if (toggleText) {
        toggleText.textContent = isOpen ? 'Collapse Lab' : 'Open Lab';
      }
    }

    if (isOpen) {
      service.startStatsPolling(1500);
      refreshTimeline();
      refreshInspector();
      refreshStats();
    } else {
      service.stopStatsPolling();
      // Hide readable content when panel closes (Privacy requirement)
      isRevealed = false;
    }
  }

  // Bind toggle button
  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      setPanelOpen(!isOpen);
    });
  }

  // Bind clear history button
  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      service.clearHistory();
      selectedEventId = null;
      isRevealed = false;
      refreshTimeline();
      refreshInspector();
      refreshCounter();
    });
  }

  // Bind filter buttons
  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter || 'all';
      refreshTimeline();
    });
  });

  // Bind timeline event click / keyboard selection (delegated)
  if (timelineHost) {
    const handleSelect = (el) => {
      const itemEl = el.closest('.netlab-event-item');
      if (!itemEl) return;
      const eventId = itemEl.dataset.eventId;
      if (eventId && eventId !== selectedEventId) {
        selectedEventId = eventId;
        // Privacy rule: Reset reveal state when selection changes
        isRevealed = false;
        refreshTimeline();
        refreshInspector();
      }
    };

    timelineHost.addEventListener('click', (e) => handleSelect(e.target));
    timelineHost.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelect(e.target);
      }
    });
  }

  // Subscribe to service events
  unsubs.push(
    service.on('event', () => {
      refreshCounter();
      refreshTimeline();
    })
  );

  unsubs.push(
    service.on('stats', (statsMap) => {
      refreshStats(statsMap);
    })
  );

  unsubs.push(
    service.on('clear', () => {
      selectedEventId = null;
      isRevealed = false;
      refreshCounter();
      refreshTimeline();
      refreshInspector();
    })
  );

  // Initial render
  refreshCounter();
  refreshTimeline();
  refreshInspector();
  refreshStats();

  if (isOpen) {
    service.startStatsPolling(1500);
  }

  const controller = {
    update: () => {
      refreshCounter();
      refreshTimeline();
      refreshInspector();
      refreshStats();
    },
    selectEvent: (id) => {
      selectedEventId = id;
      isRevealed = false;
      refreshTimeline();
      refreshInspector();
    },
    setOpen: setPanelOpen,
    destroy: () => {
      service.stopStatsPolling();
      unsubs.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
      unsubs.length = 0;
      delete panelEl._netLabController;
    },
  };

  panelEl._netLabController = controller;
  return controller;
}
