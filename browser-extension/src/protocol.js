/*
 * Copyright 2026 Kuali contributors
 * SPDX-License-Identifier: Apache-2.0
 * Kuali implementation of the Vexa-derived capture.v1 wire contract.
 */

export function encodeAudio(channel, timestamp, pcm) {
  const samples = Float32Array.from(pcm);
  const out = new ArrayBuffer(12 + samples.byteLength);
  const view = new DataView(out);
  view.setUint32(0, channel >>> 0, true);
  view.setFloat64(4, timestamp, true);
  new Float32Array(out, 12).set(samples);
  return out;
}

export function encodeMeetingEvent(event) {
  return JSON.stringify({
    kind: event.kind,
    ts: event.ts || Date.now(),
    speaker: event.speaker || null,
    text: event.text || null,
    detail: event.detail || null,
  });
}

export const SCREEN_RECORDING_WEBM = 1;

export function encodeRecordingChunk(sequence, isFinal, format, bytes) {
  if (!Number.isInteger(sequence) || sequence < 0) throw new RangeError("invalid recording sequence");
  if (!Number.isInteger(format) || format < 0) throw new RangeError("invalid recording format");
  const payload = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  const out = new ArrayBuffer(16 + payload.byteLength);
  const view = new DataView(out);
  view.setUint32(0, 0x52454331, true);
  view.setUint32(4, sequence >>> 0, true);
  view.setUint32(8, isFinal ? 1 : 0, true);
  view.setUint32(12, format >>> 0, true);
  new Uint8Array(out, 16).set(payload);
  return out;
}

export function mapFrameChannel(frameSlot, localChannel) {
  if (!Number.isInteger(frameSlot) || frameSlot < 0) throw new RangeError("invalid frame slot");
  if (!Number.isInteger(localChannel) || localChannel < 0 || localChannel >= 2048) {
    throw new RangeError("invalid local channel");
  }
  return frameSlot * 2048 + localChannel;
}
