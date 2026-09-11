/* Copyright 2026 Kuali contributors · SPDX-License-Identifier: Apache-2.0 */

export const LOCAL_MICROPHONE_CHANNEL = 1000;
export const LOCAL_MICROPHONE_SAMPLE_RATE = 16000;

/** Only the page's reserved local-microphone lane belongs in the screen mix. */
export function shouldMixLocalMicrophone({ localChannel, captureScreen, fallbackActive }) {
  return localChannel === LOCAL_MICROPHONE_CHANNEL
    && captureScreen === true
    && fallbackActive === true;
}

/**
 * Place one timestamped microphone buffer on the recording clock. Chrome
 * delivers completed PCM buffers slightly after they were spoken, so late
 * buffers start just ahead of the playhead. Consecutive buffers remain
 * contiguous, while timestamp gaps retain real silence between utterances.
 */
export function microphoneChunkTiming({
  timestampMs,
  sampleCount,
  sampleRate = LOCAL_MICROPHONE_SAMPLE_RATE,
  wallClockAnchorMs,
  audioClockAnchorSeconds,
  currentTimeSeconds,
  scheduledUntilSeconds = 0,
  safetyDelaySeconds = 0.02,
}) {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
    throw new RangeError("invalid microphone sample count");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("invalid microphone sample rate");
  }
  const timestamp = Number.isFinite(timestampMs) ? timestampMs : wallClockAnchorMs;
  const mappedTime = audioClockAnchorSeconds
    + (timestamp - wallClockAnchorMs) / 1000
    + safetyDelaySeconds;
  const earliestTime = currentTimeSeconds + safetyDelaySeconds;
  const startTime = Math.max(earliestTime, mappedTime, scheduledUntilSeconds);
  const durationSeconds = sampleCount / sampleRate;
  return {
    startTime,
    durationSeconds,
    endTime: startTime + durationSeconds,
  };
}
