/* Copyright 2026 Kuali contributors · SPDX-License-Identifier: Apache-2.0 */

/**
 * Only the top document owns the authoritative Meet roster. Once it has seen
 * the current user, that user's persistent disappearance means the call UI was
 * left; the background worker adds a short grace period before stopping.
 */
export function meetingPresence(frameId, hadSelf, participants) {
  if (frameId !== 0 || !Array.isArray(participants)) return null;
  const selfPresent = participants.some((participant) => participant?.isSelf);
  return {
    selfPresent,
    hadSelf: hadSelf || selfPresent,
    shouldScheduleStop: hadSelf && !selfPresent,
  };
}

export function shouldPromoteMixedFallback(
  timestamp,
  lastSeparateAudioAt,
  fallbackStartedAt,
  graceMs = 1_800,
) {
  const reference = Math.max(lastSeparateAudioAt || 0, fallbackStartedAt || 0);
  return reference > 0 && timestamp - reference >= graceMs;
}

export function fallbackFramesAfterSeparateAudio(frames, lastSeparateAudioAt, overlapMs = 250) {
  const after = lastSeparateAudioAt ? lastSeparateAudioAt + overlapMs : 0;
  return frames.filter((frame) => frame.ts >= after);
}
