/*
 * Copyright 2026 Kuali contributors
 * SPDX-License-Identifier: Apache-2.0
 * Kuali implementation of the Vexa-derived capture.v1 wire contract.
 */
import {
  encodeAudio,
  encodeMeetingEvent,
  encodeRecordingChunk,
  mapFrameChannel,
  SCREEN_RECORDING_WEBM,
} from "./protocol.js";
import {
  captureDefaultsFromHealthMessage,
  healthUrl,
  isKualiHealthMessage,
  isValidPairingToken,
} from "./health.js";
import {
  fallbackFramesAfterSeparateAudio,
  meetingPresence,
  shouldPromoteMixedFallback,
} from "./lifecycle.js";
import {
  LOCAL_MICROPHONE_CHANNEL,
  LOCAL_MICROPHONE_SAMPLE_RATE,
  shouldMixLocalMicrophone,
} from "./recording-audio.js";

const DEFAULT_PORT = 9099;
const HEALTH_TIMEOUT_MS = 900;
const HEALTH_CACHE_MS = 3_000;
const MEETING_END_GRACE_MS = 3_500;
const STOP_REASONS = new Set([
  "user",
  "meeting-left",
  "tab-closed",
  "platform-navigation",
  "restart",
]);
const sessions = new Map();
let healthCache = {
  key: null,
  checkedAt: 0,
  available: false,
  capture: null,
  pending: null,
};
const translated = (key, fallback, substitutions) => (
  chrome.i18n?.getMessage(key, substitutions) || fallback
);

function stateFor(tabId) {
  let state = sessions.get(tabId);
  if (!state) {
    state = {
      status: "idle",
      socket: null,
      keepAlive: null,
      info: null,
      error: null,
      warning: null,
      stopPromise: null,
      frames: new Map([[0, 0]]),
      nextFrameSlot: 1,
      channels: new Map(),
      tracks: new Map(),
      participantCount: 0,
      participantCountsByFrame: new Map(),
      selfPresent: false,
      hadSelf: false,
      meetingEndTimer: null,
      fallbackStreamId: null,
      fallbackPending: [],
      fallbackTimer: null,
      fallbackPromoted: false,
      fallbackActive: false,
      fallbackStartedAt: 0,
      lastSeparateAudioAt: 0,
      capture: { audio: false, screen: false, diagnostics: false },
    };
    sessions.set(tabId, state);
  }
  return state;
}

function cancelAutomaticStop(state) {
  clearTimeout(state.meetingEndTimer);
  state.meetingEndTimer = null;
}

function scheduleAutomaticStop(tabId, state) {
  if (state.meetingEndTimer || !state.hadSelf || state.selfPresent) return;
  state.meetingEndTimer = setTimeout(() => {
    state.meetingEndTimer = null;
    if (state.status === "capturing" && state.hadSelf && !state.selfPresent) {
      stop(tabId, { reason: "meeting-left" });
    }
  }, MEETING_END_GRACE_MS);
}

function needsMixedFallback(platform) {
  return ["google_meet", "zoom", "microsoft_teams"].includes(platform);
}

function sanitizeCaptureError(value) {
  const detail = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return detail || "Chrome did not return a tab stream identifier.";
}

function mintTabStream(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        const error = chrome.runtime.lastError?.message;
        resolve({
          streamId: streamId || null,
          error: error || (!streamId ? "Chrome did not return a tab stream identifier." : null),
        });
      });
    } catch (error) {
      resolve({ streamId: null, error: String(error?.message || error) });
    }
  });
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture and replay the meeting tab for resilient local audio and optional screen recording",
  });
}

async function startMixedFallback(tabId, state) {
  const streamId = state.fallbackStreamId;
  if (!streamId) return { ok: false, error: "Chrome did not provide a tab stream identifier." };
  try {
    await ensureOffscreen();
    const status = await chrome.runtime.sendMessage({ type: "mixed-capture-status" }).catch(() => null);
    if (status?.active && status.tabId !== tabId) {
      return {
        ok: false,
        error: `Another meeting tab (${status.tabId}) already owns the offscreen capture.`,
      };
    }
    if (status?.active && status.tabId === tabId) {
      await chrome.runtime.sendMessage({ type: "mixed-capture-stop", tabId }).catch(() => {});
    }
    const result = await chrome.runtime.sendMessage({
      type: "mixed-capture-start",
      tabId,
      streamId,
      recordScreen: state.capture.screen === true,
    });
    if (result?.ok === false) throw new Error(result.error);
    if (state.status !== "capturing" || state.fallbackStreamId !== streamId) {
      await chrome.runtime.sendMessage({ type: "mixed-capture-stop", tabId }).catch(() => {});
      return { ok: false, error: "Capture was superseded while the tab stream was starting." };
    }
    state.fallbackActive = true;
    state.fallbackStartedAt = Date.now();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function stopMixedFallback(tabId, state) {
  clearTimeout(state.fallbackTimer);
  state.fallbackTimer = null;
  state.fallbackPending.length = 0;
  state.fallbackStartedAt = 0;
  const wasActive = state.fallbackActive;
  state.fallbackActive = false;
  const status = await chrome.runtime.sendMessage({ type: "mixed-capture-status" }).catch(() => null);
  if ((status?.active && status.tabId === tabId) || (!status && wasActive)) {
    await chrome.runtime.sendMessage({ type: "mixed-capture-stop", tabId }).catch(() => {});
  }
  state.fallbackStreamId = null;
}

function promoteMixedFallback(tabId, state) {
  state.fallbackTimer = null;
  if (state.fallbackPromoted || state.status !== "capturing") return;
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  state.fallbackPromoted = true;
  const detail = {
    channel: 999,
    participantId: `${state.info.platform}:mixed`,
    displayName: "Sala",
    avatarUrl: null,
    isSelf: false,
    audioKind: "mixed",
    platform: state.info.platform,
  };
  state.channels.set(999, detail);
  socket.send(encodeMeetingEvent({
    kind: "participant-upsert",
    ts: Date.now(),
    speaker: "Sala",
    detail,
  }));
  socket.send(encodeMeetingEvent({
    kind: "capture-fallback",
    ts: Date.now(),
    detail: {
      state: "promoted",
      reason: "separate-audio-stalled",
      lastSeparateAudioAt: state.lastSeparateAudioAt || null,
    },
  }));
  for (const frame of fallbackFramesAfterSeparateAudio(
    state.fallbackPending,
    state.lastSeparateAudioAt,
  )) {
    socket.send(encodeAudio(999, frame.ts, frame.pcm));
  }
  state.fallbackPending.length = 0;
  publish(tabId);
}

function preferPageAudio(tabId, state) {
  state.lastSeparateAudioAt = Date.now();
  if (!state.fallbackPromoted) return;
  const socket = state.socket;
  if (state.fallbackPromoted && socket?.readyState === WebSocket.OPEN) {
    socket.send(encodeMeetingEvent({
      kind: "capture-fallback",
      ts: Date.now(),
      detail: { state: "standby", reason: "separate-audio-resumed" },
    }));
    socket.send(encodeMeetingEvent({
      kind: "participant-left",
      ts: Date.now(),
      speaker: "Sala",
      detail: { channel: 999, participantId: `${state.info.platform}:mixed` },
    }));
    state.channels.delete(999);
  }
  state.fallbackPromoted = false;
  state.fallbackPending.length = 0;
  publish(tabId);
}

function rememberFrame(state, frameId = 0) {
  if (!state.frames.has(frameId)) state.frames.set(frameId, state.nextFrameSlot++);
}

function wireChannel(state, frameId, localChannel) {
  rememberFrame(state, frameId);
  // Each frame receives a block of 2,048 channels. The top frame retains
  // reserved channels 999 (mixed) and 1000 (microphone) for compatibility.
  return mapFrameChannel(state.frames.get(frameId), localChannel);
}

async function recoverTabRegistration(tabId, state) {
  if (state.info) return true;
  try {
    const info = await chrome.tabs.sendMessage(
      tabId,
      { type: "capture-identify" },
      { frameId: 0 },
    );
    if (!info || !["google_meet", "microsoft_teams", "zoom"].includes(info.platform)) {
      return false;
    }
    rememberFrame(state, 0);
    state.info = {
      platform: info.platform,
      meetingId: info.meetingId,
      title: info.title,
    };
    return true;
  } catch (_) {
    return false;
  }
}

function sendControl(tabId, state, command) {
  for (const frameId of state.frames.keys()) {
    chrome.tabs.sendMessage(
      tabId,
      { type: "capture-control", command },
      { frameId },
    ).catch(() => {});
  }
}

function publish(tabId) {
  const state = stateFor(tabId);
  const message = {
    type: "capture-status",
    tabId,
    status: state.status,
    error: state.error,
    warning: state.warning,
    capture: { ...state.capture },
    platform: state.info?.platform,
    participantCount: state.participantCount,
    connectedTracks: state.tracks.size,
    separateChannels: [...state.channels.values()].filter((channel) => channel.audioKind !== "mixed").length,
    mixedChannels: [...state.channels.values()].filter((channel) => channel.audioKind === "mixed").length,
  };
  chrome.runtime.sendMessage(message).catch(() => {});
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#be123c" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: state.status === "capturing" ? "REC" : "" }).catch(() => {});
  chrome.action.setTitle({
    tabId,
    title: state.status === "capturing"
      ? translated("recordingIndicator", "Kuali is recording and transcribing")
      : "Kuali",
  }).catch(() => {});
}

function sendDiagnostic(state, kind, detail) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(encodeMeetingEvent({ kind, ts: Date.now(), detail }));
}

function markCaptureDegraded(tabId, state, error) {
  const detail = sanitizeCaptureError(error);
  state.capture.screen = false;
  state.warning = translated(
    "audioOnlyCaptureWarning",
    `Recording and transcribing audio only; tab video is unavailable. Chrome: ${detail}`,
    [detail],
  );
  sendDiagnostic(state, "capture-degraded", {
    capability: "screen",
    effective: false,
    reason: detail,
  });
  publish(tabId);
}

async function connectionSettings() {
  const stored = await chrome.storage.local.get({
    kualiPort: DEFAULT_PORT,
    kualiPairingToken: "",
  });
  const value = Number(stored.kualiPort);
  return {
    port: Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_PORT,
    pairingToken: String(stored.kualiPairingToken || "").trim(),
  };
}

async function kualiAvailable() {
  const { port: wsPort, pairingToken } = await connectionSettings();
  if (!isValidPairingToken(pairingToken)) {
    healthCache = {
      key: `${wsPort}:missing-pairing-token`,
      checkedAt: Date.now(),
      available: false,
      capture: null,
      pending: null,
    };
    return false;
  }
  const cacheKey = `${wsPort}:${pairingToken}`;
  const now = Date.now();
  if (healthCache.key === cacheKey && healthCache.pending) return healthCache.pending;
  if (healthCache.key === cacheKey && now - healthCache.checkedAt < HEALTH_CACHE_MS) {
    return healthCache.available;
  }

  const pending = new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (available, capture = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      healthCache = {
        key: cacheKey,
        checkedAt: Date.now(),
        available,
        capture,
        pending: null,
      };
      try { socket?.close(1000, "health checked"); } catch (_) {}
      resolve(available);
    };
    const timer = setTimeout(() => finish(false), HEALTH_TIMEOUT_MS);
    try {
      socket = new WebSocket(healthUrl(wsPort, pairingToken));
      socket.onmessage = (event) => {
        const available = isKualiHealthMessage(event.data);
        const capture = available ? captureDefaultsFromHealthMessage(event.data) : null;
        finish(available, capture);
      };
      socket.onerror = () => finish(false);
      socket.onclose = () => finish(false);
    } catch (_) {
      finish(false);
    }
  });
  healthCache = {
    key: cacheKey,
    checkedAt: 0,
    available: false,
    capture: null,
    pending,
  };
  return pending;
}

async function start(tabId, options = {}, preparedCapture = {}) {
  const state = stateFor(tabId);
  await recoverTabRegistration(tabId, state);
  if (!state.info) {
    state.error = translated("unsupportedMeetingError", "This tab is not a supported meeting.");
    publish(tabId);
    return;
  }
  const { port: wsPort, pairingToken } = await connectionSettings();
  if (!isValidPairingToken(pairingToken)) {
    state.error = translated(
      "missingPairingCodeError",
      "Enter the 32-character pairing code from Kuali Settings before recording.",
    );
    publish(tabId);
    return;
  }
  await stop(tabId, { notify: false, reason: "restart" });
  state.hadSelf = false;
  state.selfPresent = false;
  state.error = null;
  state.warning = null;
  state.lastSeparateAudioAt = 0;
  state.capture = { audio: false, screen: false, diagnostics: false };
  const requestedScreen = options?.screen === true;
  let tabCaptureError = null;
  if (needsMixedFallback(state.info.platform)) {
    const suppliedByPopup = Object.hasOwn(preparedCapture, "tabStreamId")
      || Object.hasOwn(preparedCapture, "tabCaptureError");
    const prepared = suppliedByPopup
      ? {
          streamId: typeof preparedCapture.tabStreamId === "string"
            ? preparedCapture.tabStreamId.trim() || null
            : null,
          error: preparedCapture.tabCaptureError,
        }
      : await mintTabStream(tabId);
    state.fallbackStreamId = prepared.streamId;
    tabCaptureError = prepared.error ? sanitizeCaptureError(prepared.error) : null;
  }
  state.status = "connecting";
  publish(tabId);

  const query = new URLSearchParams({
    platform: state.info.platform,
    native_meeting_id: state.info.meetingId || state.info.title || translated("meetingFallbackName", "Meeting"),
    client: "kuali-extension",
    protocol: "capture.v1+participants",
    pairing_token: pairingToken,
  });
  if (typeof options?.screen === "boolean") {
    query.set("capture_screen", options.screen && state.fallbackStreamId ? "1" : "0");
  }
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ingest?${query}`);
  state.socket = socket;

  socket.onopen = () => {
    if (state.socket !== socket) return socket.close();
    state.status = "waiting";
    publish(tabId);
  };
  socket.onmessage = async (message) => {
    if (state.socket !== socket) return;
    try {
      const response = JSON.parse(message.data);
      if (response?.type === "error") {
        state.error = response.message || translated("captureRejectedError", "Kuali rejected this capture.");
        socket.close(1000, "capture rejected");
        publish(tabId);
        return;
      }
      if (response?.type !== "ready") return;
      state.capture = {
        audio: response.capture?.audio === true,
        screen: response.capture?.screen === true,
        diagnostics: response.capture?.diagnostics === true,
      };
      state.status = "capturing";
      clearInterval(state.keepAlive);
      // Chrome 116+ preserves the service worker while its WebSocket exchanges
      // data. A meeting can easily stay silent beyond the 30-second idle limit.
      state.keepAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(encodeMeetingEvent({
            kind: "keepalive",
            ts: Date.now(),
            detail: { client: "kuali-extension" },
          }));
        }
      }, 20_000);
      // Build the recording graph before page capture starts. This prevents the
      // first local-microphone buffer from racing ahead of the offscreen mixer.
      const fallback = needsMixedFallback(state.info.platform)
        ? await startMixedFallback(tabId, state)
        : { ok: true, error: null };
      if (state.socket !== socket || state.status !== "capturing") return;
      if (requestedScreen && (!state.fallbackStreamId || fallback.ok === false)) {
        markCaptureDegraded(
          tabId,
          state,
          tabCaptureError || fallback.error || "Chrome could not start tab video capture.",
        );
      } else if (!state.fallbackActive) {
        state.capture.screen = false;
      }
      socket.send(encodeMeetingEvent({
        kind: "capture-options",
        ts: Date.now(),
        detail: state.capture,
      }));
      publish(tabId);
      if (state.socket === socket && state.status === "capturing") {
        sendControl(tabId, state, "start");
      }
    } catch (_) {}
  };
  socket.onerror = () => {
    if (state.socket !== socket) return;
    state.error = translated(
      "connectionError",
      "Could not connect to Kuali on this computer. Open the app and try again.",
    );
  };
  socket.onclose = () => {
    if (state.socket !== socket) return;
    // Reuse the serialized cleanup path so an immediate retry cannot race an
    // offscreen shutdown left behind by the disconnected socket.
    stop(tabId, { reason: "restart" }).catch(() => {});
  };
}

async function stop(tabId, { notify = true, reason = "user" } = {}) {
  const state = stateFor(tabId);
  if (state.stopPromise) return state.stopPromise;
  const normalizedReason = STOP_REASONS.has(reason) ? reason : "user";
  const operation = (async () => {
    const socket = state.socket;
    const wasRunning = Boolean(socket)
      || ["connecting", "waiting", "capturing"].includes(state.status)
      || state.fallbackActive;
    if (wasRunning) sendDiagnostic(state, "capture-stop", { reason: normalizedReason });
    if (notify) sendControl(tabId, state, "stop");
    // Keep the socket open until MediaRecorder has emitted and forwarded its
    // final chunk. Otherwise the last second of a normal stop would be lost.
    await stopMixedFallback(tabId, state);
    clearInterval(state.keepAlive);
    state.keepAlive = null;
    state.socket = null;
    state.status = "idle";
    state.channels.clear();
    state.tracks.clear();
    state.participantCount = 0;
    state.participantCountsByFrame.clear();
    state.selfPresent = false;
    state.hadSelf = false;
    state.warning = null;
    state.capture = { audio: false, screen: false, diagnostics: false };
    cancelAutomaticStop(state);
    state.fallbackPromoted = false;
    if (socket) socket.close(1000, `capture stopped: ${normalizedReason}`);
    publish(tabId);
  })();
  state.stopPromise = operation;
  try {
    await operation;
  } finally {
    if (state.stopPromise === operation) state.stopPromise = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // The offscreen document consumes this message. Do not leave a phantom reply
  // channel open from the service worker itself.
  if (["mixed-capture-start", "mixed-capture-stop", "mixed-capture-status"].includes(message.type)) {
    return undefined;
  }
  const tabId = message.tabId ?? sender.tab?.id;
  if (tabId == null) return;
  const state = stateFor(tabId);
  switch (message.type) {
    case "frame-ready":
      {
        const frameId = sender.frameId ?? 0;
        rememberFrame(state, frameId);
        if (message.platform) state.info = {
          platform: message.platform,
          meetingId: message.meetingId,
          title: message.title,
        };
        if (state.status === "capturing") {
          chrome.tabs.sendMessage(
            tabId,
            { type: "capture-control", command: "start" },
            { frameId },
          ).catch(() => {});
        }
        publish(tabId);
      }
      break;
    case "capture-start":
      start(tabId, message.options, {
        ...(Object.hasOwn(message, "tabStreamId") ? { tabStreamId: message.tabStreamId } : {}),
        ...(Object.hasOwn(message, "tabCaptureError") ? { tabCaptureError: message.tabCaptureError } : {}),
      });
      break;
    case "capture-stop":
      stop(tabId, { reason: message.reason || "user" });
      break;
    case "capture-state":
      recoverTabRegistration(tabId, state).then(() => connectionSettings()).then(async ({ pairingToken }) => {
        const pairingConfigured = isValidPairingToken(pairingToken);
        const available = pairingConfigured ? await kualiAvailable() : false;
        reply({
          status: state.status,
          error: state.error,
          warning: state.warning,
          capture: { ...state.capture },
          platform: state.info?.platform,
          participantCount: state.participantCount,
          connectedTracks: state.tracks.size,
          separateChannels: [...state.channels.values()].filter((channel) => channel.audioKind !== "mixed").length,
          mixedChannels: [...state.channels.values()].filter((channel) => channel.audioKind === "mixed").length,
          pairingConfigured,
          kualiAvailable: available,
          captureDefaults: healthCache.capture,
        });
      }).catch(() => reply({
        status: state.status,
        error: state.error,
        warning: state.warning,
        capture: { ...state.capture },
        platform: state.info?.platform,
        pairingConfigured: false,
        kualiAvailable: false,
      }));
      return true;
    case "capture-event": {
      const socket = state.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || state.status !== "capturing") break;
      const event = message.event;
      const frameId = sender.frameId ?? 0;
      if (event.type === "audio" && Number.isInteger(event.channel) && Array.isArray(event.pcm)) {
        const channel = wireChannel(state, frameId, event.channel);
        const binding = state.channels.get(channel);
        if (binding && binding.audioKind !== "mixed" && binding.isSelf !== true) {
          preferPageAudio(tabId, state);
        }
        socket.send(encodeAudio(channel, event.ts || Date.now(), event.pcm));
        if (shouldMixLocalMicrophone({
          localChannel: event.channel,
          captureScreen: state.capture.screen,
          fallbackActive: state.fallbackActive,
        })) {
          chrome.runtime.sendMessage({
            type: "recording-microphone-pcm",
            tabId,
            ts: event.ts || Date.now(),
            sampleRate: LOCAL_MICROPHONE_SAMPLE_RATE,
            pcm: event.pcm,
          }).catch(() => {});
        }
      } else if (event.type === "meeting-event") {
        const detail = event.detail ? { ...event.detail } : null;
        if (detail && Number.isInteger(detail.channel)) {
          detail.channel = wireChannel(state, frameId, detail.channel);
        }
        if (detail && Number.isInteger(detail.index)) {
          detail.index = wireChannel(state, frameId, detail.index);
        }
        if (event.kind === "track-connected" && detail && Number.isInteger(detail.channel)) {
          // Transport lanes are not people. Meet currently exposes a reusable
          // three-lane remote pool even when only one remote participant exists.
          state.tracks.set(detail.channel, detail);
          publish(tabId);
        } else if (event.kind === "participant-upsert" && detail && Number.isInteger(detail.channel)) {
          state.channels.set(detail.channel, detail);
          publish(tabId);
        } else if (event.kind === "participant-left" && detail && Number.isInteger(detail.channel)) {
          state.channels.delete(detail.channel);
          state.tracks.delete(detail.channel);
          publish(tabId);
        } else if (event.kind === "roster-state" && detail) {
          if (Number.isInteger(detail.participantCount)) {
            // Meet runs Kuali in the top document and a few child frames. A
            // child may only see the current user and must not overwrite the
            // complete four-person roster seen by the top document.
            state.participantCountsByFrame.set(frameId, Math.max(0, detail.participantCount));
            state.participantCount = Math.max(0, ...state.participantCountsByFrame.values());
          }
          const presence = meetingPresence(frameId, state.hadSelf, detail);
          if (presence) {
            state.selfPresent = presence.selfPresent;
            state.hadSelf = presence.hadSelf;
            if (presence.selfPresent) {
              cancelAutomaticStop(state);
            } else if (presence.shouldScheduleStop) {
              scheduleAutomaticStop(tabId, state);
            }
          }
          publish(tabId);
        }
        if (event.kind !== "meet-probe" || state.capture.diagnostics) {
          socket.send(encodeMeetingEvent({ ...event, detail }));
        }
      }
      break;
    }
    case "mixed-audio": {
      const socket = state.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || state.status !== "capturing") break;
      const timestamp = message.ts || Date.now();
      if (state.fallbackPromoted) {
        socket.send(encodeAudio(999, message.ts || Date.now(), message.pcm || []));
        break;
      }
      state.fallbackPending.push({ ts: timestamp, pcm: message.pcm || [] });
      if (state.fallbackPending.length > 40) state.fallbackPending.shift();
      if (shouldPromoteMixedFallback(
        timestamp,
        state.lastSeparateAudioAt,
        state.fallbackStartedAt,
      )) {
        promoteMixedFallback(tabId, state);
      }
      break;
    }
    case "recording-chunk": {
      const socket = state.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || state.status !== "capturing") break;
      if (!state.capture.screen || message.format !== SCREEN_RECORDING_WEBM) break;
      const bytes = Uint8Array.from(message.bytes || []);
      if (bytes.byteLength > 2 * 1024 * 1024 - 16) {
        state.error = translated(
          "screenChunkTooLargeError",
          "A screen recording chunk exceeded the local safety limit.",
        );
        publish(tabId);
        break;
      }
      socket.send(encodeRecordingChunk(
        message.sequence,
        message.isFinal === true,
        message.format,
        bytes,
      ));
      break;
    }
    case "recording-error": {
      const socket = state.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        if (state.capture.screen) {
          markCaptureDegraded(tabId, state, message.error || "MediaRecorder failed");
        }
        socket.send(encodeMeetingEvent({
          kind: "warning",
          ts: Date.now(),
          detail: { code: "screen-recording-failed", message: message.error || "MediaRecorder failed" },
        }));
      }
      break;
    }
  }
  // Messages that do not produce a reply must close their port immediately.
  // Offscreen recording shutdown awaits these promises before finalizing the
  // WebM, so falsely advertising an async response would deadlock Stop.
  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!sessions.has(tabId)) return;
  stop(tabId, { notify: false, reason: "tab-closed" })
    .finally(() => sessions.delete(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || !sessions.has(tabId)) return;
  const state = stateFor(tabId);
  if (!["connecting", "waiting", "capturing"].includes(state.status)) return;
  try {
    const next = new URL(changeInfo.url);
    const stillOnPlatform = state.info?.platform === "google_meet"
      ? next.hostname === "meet.google.com"
      : state.info?.platform === "zoom"
        ? next.hostname === "zoom.us" || next.hostname.endsWith(".zoom.us")
        : next.hostname === "teams.microsoft.com";
    if (!stillOnPlatform) stop(tabId, { notify: false, reason: "platform-navigation" });
  } catch (_) {
    stop(tabId, { notify: false, reason: "platform-navigation" });
  }
});
