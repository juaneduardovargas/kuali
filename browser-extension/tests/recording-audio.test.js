import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_MICROPHONE_CHANNEL,
  microphoneChunkTiming,
  shouldMixLocalMicrophone,
} from "../src/recording-audio.js";

test("only the reserved local microphone is added to an active screen recording", () => {
  assert.equal(shouldMixLocalMicrophone({
    localChannel: LOCAL_MICROPHONE_CHANNEL,
    captureScreen: true,
    fallbackActive: true,
  }), true);
  assert.equal(shouldMixLocalMicrophone({
    localChannel: 2,
    captureScreen: true,
    fallbackActive: true,
  }), false);
  assert.equal(shouldMixLocalMicrophone({
    localChannel: LOCAL_MICROPHONE_CHANNEL,
    captureScreen: false,
    fallbackActive: true,
  }), false);
});

test("microphone chunks stay contiguous when runtime delivery is late", () => {
  const first = microphoneChunkTiming({
    timestampMs: 1_128,
    sampleCount: 2048,
    wallClockAnchorMs: 1_000,
    audioClockAnchorSeconds: 5,
    currentTimeSeconds: 5.15,
  });
  assert.equal(first.startTime, 5.17);
  assert.equal(first.durationSeconds, 0.128);

  const second = microphoneChunkTiming({
    timestampMs: 1_256,
    sampleCount: 2048,
    wallClockAnchorMs: 1_000,
    audioClockAnchorSeconds: 5,
    currentTimeSeconds: 5.27,
    scheduledUntilSeconds: first.endTime,
  });
  assert.equal(second.startTime, first.endTime);
});

test("microphone timestamps preserve a real silence gap", () => {
  const timing = microphoneChunkTiming({
    timestampMs: 3_000,
    sampleCount: 2048,
    wallClockAnchorMs: 1_000,
    audioClockAnchorSeconds: 5,
    currentTimeSeconds: 6,
    scheduledUntilSeconds: 5.5,
  });
  assert.equal(timing.startTime, 7.02);
});
