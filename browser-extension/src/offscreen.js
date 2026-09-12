/*
 * Copyright 2026 Kuali contributors
 * SPDX-License-Identifier: Apache-2.0
 * Mixed-tab fallback adapted from Vexa's Apache-2.0 offscreen capture path.
 */

import {
  LOCAL_MICROPHONE_SAMPLE_RATE,
  microphoneChunkTiming,
} from "./recording-audio.js";

const TARGET_RATE = 16000;
let tabId = null;
let stream = null;
let captureContext = null;
let playbackContext = null;
let processor = null;
let mediaRecorder = null;
let recordingContext = null;
let recordingDestination = null;
let recordingMix = null;
let recordingTabSource = null;
let recordingTabGain = null;
let recordingMicGain = null;
let recordingStream = null;
let recordingClock = null;
let recordingMicScheduledUntil = 0;
const recordingMicSources = new Set();
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

function queueMicrophonePcm(message) {
  if (message.tabId !== tabId
    || !mediaRecorder
    || mediaRecorder.state === "inactive"
    || !recordingContext
    || !recordingMicGain
    || !recordingClock
    || !Array.isArray(message.pcm)
    || message.pcm.length === 0
    || message.pcm.length > 8192) return;

  const sampleRate = Number(message.sampleRate);
  if (sampleRate !== LOCAL_MICROPHONE_SAMPLE_RATE) return;
  const samples = Float32Array.from(message.pcm, (sample) => {
    const value = Number(sample);
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  });
  const timing = microphoneChunkTiming({
    timestampMs: Number(message.ts),
    sampleCount: samples.length,
    sampleRate,
    wallClockAnchorMs: recordingClock.wallClockMs,
    audioClockAnchorSeconds: recordingClock.audioTime,
    currentTimeSeconds: recordingContext.currentTime,
    scheduledUntilSeconds: recordingMicScheduledUntil,
  });
  const buffer = recordingContext.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = recordingContext.createBufferSource();
  source.buffer = buffer;
  source.connect(recordingMicGain);
  recordingMicSources.add(source);
  source.addEventListener("ended", () => {
    recordingMicSources.delete(source);
    source.disconnect();
  }, { once: true });
  source.start(timing.startTime);
  recordingMicScheduledUntil = timing.endTime;
}

async function drainMicrophoneMix() {
  if (!recordingContext) return;
  const remainingMs = Math.max(
    0,
    Math.min(200, (recordingMicScheduledUntil - recordingContext.currentTime) * 1000),
  );
  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }
}

async function stopRecordingGraph() {
  for (const source of recordingMicSources) {
    try { source.stop(); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
  }
  recordingMicSources.clear();
  for (const track of recordingDestination?.stream?.getTracks?.() || []) track.stop();
  await recordingContext?.close?.().catch(() => {});
  recordingContext = null;
  recordingDestination = null;
  recordingMix = null;
  recordingTabSource = null;
  recordingTabGain = null;
  recordingMicGain = null;
  recordingStream = null;
  recordingClock = null;
  recordingMicScheduledUntil = 0;
}

async function stopTab() {
  if (processor?.port) processor.port.onmessage = null;
  try { processor?.disconnect?.(); } catch (_) {}
  await drainMicrophoneMix();
  await stopRecorder();
  await stopRecordingGraph();
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
  await captureContext.audioWorklet.addModule(chrome.runtime.getURL("src/pcm-worklet.js"));
  const source = captureContext.createMediaStreamSource(stream);
  processor = new AudioWorkletNode(captureContext, "kuali-pcm", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    // Match ScriptProcessor's former mono input: preserve tab content from
    // both stereo sides through the browser's standard speaker downmix.
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
  source.connect(processor);
  // The worklet leaves its output silent. A direct connection keeps Chrome
  // pulling tab audio without replaying it a second time; a zero-gain node can
  // be optimized away on some remote WebRTC paths.
  processor.connect(captureContext.destination);
  processor.port.onmessage = (event) => {
    if (tabId == null) return;
    const samples = new Float32Array(event.data);
    if (samples.length === 0 || samples.length > 8192) return;
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
    recordingContext = new AudioContext({ latencyHint: "interactive" });
    recordingDestination = recordingContext.createMediaStreamDestination();
    recordingMix = recordingContext.createDynamicsCompressor();
    recordingMix.threshold.value = -3;
    recordingMix.knee.value = 6;
    recordingMix.ratio.value = 4;
    recordingMix.attack.value = 0.003;
    recordingMix.release.value = 0.25;
    recordingTabSource = recordingContext.createMediaStreamSource(stream);
    recordingTabGain = recordingContext.createGain();
    recordingTabGain.gain.value = 0.85;
    recordingMicGain = recordingContext.createGain();
    recordingMicGain.gain.value = 1;
    recordingTabSource.connect(recordingTabGain).connect(recordingMix);
    recordingMicGain.connect(recordingMix);
    recordingMix.connect(recordingDestination);
    await recordingContext.resume();
    recordingClock = {
      wallClockMs: Date.now(),
      audioTime: recordingContext.currentTime,
    };
    recordingStream = new MediaStream([
      ...stream.getVideoTracks(),
      ...recordingDestination.stream.getAudioTracks(),
    ]);
    const mimeType = recordingMimeType();
    mediaRecorder = new MediaRecorder(recordingStream, {
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
  if (message.type === "recording-microphone-pcm") {
    queueMicrophonePcm(message);
  }
  return undefined;
});
