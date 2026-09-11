/* Copyright 2026 Kuali contributors · SPDX-License-Identifier: Apache-2.0 */

export function healthUrl(port, pairingToken) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RangeError("invalid Kuali port");
  }
  const query = new URLSearchParams({
    client: "kuali-extension",
    pairing_token: String(pairingToken || ""),
  });
  return `ws://127.0.0.1:${value}/health?${query}`;
}

export function isValidPairingToken(pairingToken) {
  return /^[0-9a-f]{32}$/i.test(String(pairingToken || "").trim());
}

export function isKualiHealthMessage(data) {
  try {
    const message = typeof data === "string" ? JSON.parse(data) : data;
    return message?.type === "health"
      && message?.service === "kuali"
      && message?.status === "ready"
      && message?.protocol === "capture.v1";
  } catch {
    return false;
  }
}

export function captureDefaultsFromHealthMessage(data) {
  try {
    const message = typeof data === "string" ? JSON.parse(data) : data;
    if (!isKualiHealthMessage(message)) return null;
    return {
      audio: message.capture?.audio === true,
      screen: message.capture?.screen === true,
      diagnostics: message.capture?.diagnostics === true,
    };
  } catch {
    return null;
  }
}
