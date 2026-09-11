/*
 * Copyright 2026 Kuali contributors
 * SPDX-License-Identifier: Apache-2.0
 * Mixed-tab fallback adapted from Vexa's Apache-2.0 offscreen capture path.
 */

const TARGET_RATE = 16000;
let tabId = null;
let stream = null;
let captureContext = null;
let playbackContext = null;
let processor = null;
let mediaRecorder = null;
let recordingSequence = 0;
let recordingQueue = Promise.resolve();

function recordingMimeType() {
  return [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function queueRecordingChunk(blob) {
  if (!blob?.size || tabId == null) return;
  const sourceTabId = tabId;
  const sequence = recordingSequence++;
  recordingQueue = recordingQueue.then(async () => {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await chrome.runtime.sendMessage({
      type: "recording-chunk",
      tabId: sourceTabId,
      sequence,
      isFinal: false,
      format: 1,
      bytes,
    });
  }).catch(() => {});
}

async function stopRecorder() {
  const recorder = mediaRecorder;
  mediaRecorder = null;
  if (!recorder) return;
  if (recorder.state !== "inactive") {
    await new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.stop();
    });
  }
  await recordingQueue;
  if (tabId != null) {
    await chrome.runtime.sendMessage({
      type: "recording-chunk",
      tabId,
      sequence: recordingSequence++,
      isFinal: true,
      format: 1,
      bytes: [],
    }).catch(() => {});
  }
}

async function stopTab() {
  if (processor) processor.onaudioprocess = null;
  await stopRecorder();
  for (const track of stream?.getTracks?.() || []) track.stop();
  stream = null;
  await captureContext?.close?.().catch(() => {});
  await playbackContext?.close?.().catch(() => {});
  captureContext = null;
  playbackContext = null;
  processor = null;
  tabId = null;
  recordingSequence = 0;
  recordingQueue = Promise.resolve();
}

async function startTab(streamId, sourceTabId, recordScreen = false) {
  await stopTab();
  tabId = sourceTabId;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: recordScreen ? {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } : false,
  });

  // tabCapture mutes the original tab. A second graph at the native sample rate
  // plays it back so the user can continue hearing the meeting.
  playbackContext = new AudioContext({ latencyHint: "interactive" });
  playbackContext.createMediaStreamSource(stream).connect(playbackContext.destination);

  captureContext = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: "interactive" });
  const source = captureContext.createMediaStreamSource(stream);
  processor = captureContext.createScriptProcessor(2048, 1, 1);
  source.connect(processor);
  // ScriptProcessor leaves its output buffer silent. A direct connection keeps
  // Chrome pulling tab audio without replaying it a second time; a zero-gain
  // node can be optimized away on some remote WebRTC paths.
  processor.connect(captureContext.destination);
  processor.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (peak < 0.0005 || tabId == null) return;
    chrome.runtime.sendMessage({
      type: "mixed-audio",
      tabId,
      ts: Date.now(),
      pcm: Array.from(samples),
    }).catch(() => {});
  };
  await captureContext.resume();
  playbackContext.resume().catch(() => {});

  if (recordScreen) {
    const mimeType = recordingMimeType();
    mediaRecorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 1_200_000,
      audioBitsPerSecond: 96_000,
    });
    mediaRecorder.addEventListener("dataavailable", (event) => queueRecordingChunk(event.data));
    mediaRecorder.addEventListener("error", (event) => {
      chrome.runtime.sendMessage({
        type: "recording-error",
        tabId,
        error: String(event.error?.message || event.error || "MediaRecorder failed"),
      }).catch(() => {});
    });
    // A bounded interval keeps each authenticated WebSocket message well below
    // the desktop's 2 MiB limit and leaves usable data after an abrupt exit.
    mediaRecorder.start(1_000);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type === "mixed-capture-start") {
    startTab(message.streamId, message.tabId, message.recordScreen === true)
      .then(() => reply({ ok: true }))
      .catch(async (error) => {
        await stopTab().catch(() => {});
        reply({ ok: false, error: String(error?.message || error) });
      });
    return true;
  }
  if (message.type === "mixed-capture-stop") {
    stopTab().then(() => reply({ ok: true }));
    return true;
  }
  return undefined;
});
