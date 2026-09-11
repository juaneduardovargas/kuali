const platformNames = {
  google_meet: "Google Meet",
  microsoft_teams: "Microsoft Teams",
  zoom: "Zoom",
};
const message = (key, substitutions, fallback) => {
  try {
    return chrome.i18n?.getMessage(key, substitutions || undefined) || fallback;
  } catch (_) {
    return fallback;
  }
};
const statusNames = {
  idle: message("waiting", null, "Ready"),
  connecting: message("connecting", null, "Connecting to Kuali…"),
  waiting: message("preparing", null, "Preparing capture…"),
  capturing: message("capturing", null, "Capturing audio"),
};

let tabId = null;
let current = "idle";
let kualiAvailable = null;
let pairingConfigured = false;
let lastState = null;
const $ = (id) => document.getElementById(id);
const validPairingToken = (value) => /^[0-9a-f]{32}$/i.test(String(value || "").trim());

document.documentElement.lang = chrome.i18n?.getUILanguage?.() || "en";
for (const element of document.querySelectorAll("[data-i18n]")) {
  element.textContent = message(element.dataset.i18n, null, element.textContent);
}

function render(state) {
  lastState = state;
  current = state?.status || "idle";
  if (typeof state?.kualiAvailable === "boolean") kualiAvailable = state.kualiAvailable;
  if (typeof state?.pairingConfigured === "boolean") pairingConfigured = state.pairingConfigured;
  $("platform").textContent = state?.platform
    ? platformNames[state.platform] || state.platform
    : message("unsupportedTab", null, "Unsupported tab");
  const channels = [];
  if (state?.participantCount) {
    channels.push(message(
      state.participantCount === 1 ? "participant" : "participants",
      [String(state.participantCount)],
      `${state.participantCount} participant${state.participantCount === 1 ? "" : "s"}`,
    ));
  } else if (state?.separateChannels) {
    channels.push(message(
      state.separateChannels === 1 ? "track" : "tracks",
      [String(state.separateChannels)],
      `${state.separateChannels} identified track${state.separateChannels === 1 ? "" : "s"}`,
    ));
  }
  if (!state?.participantCount && state?.mixedChannels) {
    channels.push(message(
      state.mixedChannels === 1 ? "mix" : "mixes",
      [String(state.mixedChannels)],
      `${state.mixedChannels} mix${state.mixedChannels === 1 ? "" : "es"}`,
    ));
  }
  $("status").textContent = current === "idle" && state?.platform && !pairingConfigured
    ? message("pairingRequired", null, "Enter the pairing code below")
    : current === "idle" && state?.platform && kualiAvailable === false
      ? message("kualiClosed", null, "Kuali is not open")
      : channels.length && current === "capturing"
        ? `${statusNames[current]} · ${channels.join(" · ")}`
        : statusNames[current] || current;
  $("status").dataset.state = current;
  const idle = current === "idle";
  const awaitingConsent = idle && Boolean(state?.platform);
  $("consent-panel").hidden = !awaitingConsent;
  $("toggle").textContent = idle
    ? message("recordAndTranscribe", null, "Record and transcribe")
    : message("stopCapture", null, "Stop capture");
  $("toggle").disabled = !state?.platform
    || current === "connecting"
    || current === "waiting"
    || (idle && !pairingConfigured)
    || (idle && kualiAvailable === false)
    || (idle && !$("participant-consent").checked);
  $("error").hidden = !state?.error;
  $("error").textContent = state?.error || "";
}

chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  tabId = tab?.id;
  const stored = await chrome.storage.local.get({
    kualiPort: 9099,
    kualiPairingToken: "",
  });
  $("port").value = stored.kualiPort;
  $("pairing-token").value = stored.kualiPairingToken;
  pairingConfigured = validPairingToken(stored.kualiPairingToken);
  if (tabId == null) return render(null);
  chrome.runtime.sendMessage({ type: "capture-state", tabId }, render);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "capture-status" && message.tabId === tabId) render(message);
});

$("toggle").addEventListener("click", async () => {
  if (tabId == null) return;
  const starting = current === "idle";
  const pairingToken = $("pairing-token").value.trim();
  if (starting && !validPairingToken(pairingToken)) {
    pairingConfigured = false;
    $("pairing-token").focus();
    render({ ...lastState, pairingConfigured: false });
    return;
  }
  if (starting && !$("participant-consent").checked) {
    $("participant-consent").focus();
    return;
  }
  if (starting) {
    // Persist before asking the service worker to connect. This avoids a race
    // when the user pastes the code and immediately presses Record.
    await chrome.storage.local.set({ kualiPairingToken: pairingToken });
  }
  chrome.runtime.sendMessage({ type: starting ? "capture-start" : "capture-stop", tabId });
  if (starting) $("participant-consent").checked = false;
});

$("participant-consent").addEventListener("change", () => render(lastState));

$("port").addEventListener("change", async () => {
  const value = Number($("port").value);
  if (Number.isInteger(value) && value > 0 && value <= 65535) {
    await chrome.storage.local.set({ kualiPort: value });
    kualiAvailable = null;
    if (tabId != null) chrome.runtime.sendMessage({ type: "capture-state", tabId }, render);
  }
});

$("pairing-token").addEventListener("change", async () => {
  const pairingToken = $("pairing-token").value.trim();
  pairingConfigured = validPairingToken(pairingToken);
  await chrome.storage.local.set({ kualiPairingToken: pairingToken });
  kualiAvailable = null;
  if (tabId != null) chrome.runtime.sendMessage({ type: "capture-state", tabId }, render);
});

$("pairing-token").addEventListener("input", () => {
  pairingConfigured = validPairingToken($("pairing-token").value);
  kualiAvailable = null;
  render({ ...lastState, pairingConfigured });
});
