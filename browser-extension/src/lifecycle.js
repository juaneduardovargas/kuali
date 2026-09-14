/* Copyright 2026 Kuali contributors · SPDX-License-Identifier: Apache-2.0 */

/**
 * Only the top document owns the authoritative Meet state. Roster nodes are
 * routinely replaced while people join, leave, or share their screen, so a
 * missing self entry is not an end-of-call signal. Once the call controls say
 * the document is no longer in a meeting, the background worker adds a short
 * grace period before stopping.
 */
export function meetingPresence(frameId, hadSelf, detail) {
  if (frameId !== 0 || !detail || typeof detail !== "object") return null;
  const participants = Array.isArray(detail.participants) ? detail.participants : [];
  const selfVisible = typeof detail.selfPresentInDom === "boolean"
    ? detail.selfPresentInDom
    : participants.some((participant) => participant?.isSelf);
  const selfPresent = detail.inCall !== false && (hadSelf || selfVisible);
  return {
    selfPresent,
    hadSelf: hadSelf || selfVisible,
    shouldScheduleStop: hadSelf && detail.inCall === false,
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

export function isSupportedPlatformUrl(platform, value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch (_) {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLocaleLowerCase();
  if (platform === "google_meet") return host === "meet.google.com";
  if (platform === "zoom") return host === "zoom.us" || host.endsWith(".zoom.us");
  if (platform === "microsoft_teams") {
    return host === "teams.microsoft.com"
      || host.endsWith(".teams.microsoft.com")
      || host === "teams.cloud.microsoft"
      || host === "teams.live.com";
  }
  return false;
}
