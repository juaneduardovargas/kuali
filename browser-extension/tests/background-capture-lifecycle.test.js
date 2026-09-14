import assert from "node:assert/strict";
import test from "node:test";

function replaceGlobal(name, value, originals) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function restoreGlobals(originals) {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}

async function settle(predicate, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("background operation did not settle");
}

async function backgroundHarness({ activeOffscreenTab = null } = {}) {
  const originals = new Map();
  const runtimeMessages = [];
  const tabMessages = [];
  const sockets = [];
  const timers = [];
  const listeners = { runtime: null, removed: null, updated: null };
  let offscreenTab = activeOffscreenTab;

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      sockets.push(this);
    }

    send(value) {
      this.sent.push(value);
    }

    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  replaceGlobal("WebSocket", FakeWebSocket, originals);
  replaceGlobal("setInterval", () => 1, originals);
  replaceGlobal("clearInterval", () => {}, originals);
  replaceGlobal("setTimeout", (callback, delay) => {
    const timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return timer;
  }, originals);
  replaceGlobal("clearTimeout", (timer) => {
    if (timer) timer.cancelled = true;
  }, originals);
  replaceGlobal("chrome", {
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    i18n: { getMessage: () => "" },
    offscreen: { createDocument: async () => {} },
    runtime: {
      getContexts: async () => [{}],
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: {
        addListener(listener) {
          listeners.runtime = listener;
        },
      },
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        if (message.type === "mixed-capture-status") {
          return {
            ok: true,
            active: offscreenTab != null,
            tabId: offscreenTab,
            recording: "inactive",
          };
        }
        if (message.type === "mixed-capture-stop") {
          if (offscreenTab === message.tabId) offscreenTab = null;
          return { ok: true };
        }
        if (message.type === "mixed-capture-start") {
          if (offscreenTab != null && offscreenTab !== message.tabId) {
            return { ok: false, error: "another tab is active" };
          }
          offscreenTab = message.tabId;
          return { ok: true };
        }
        return undefined;
      },
    },
    storage: {
      local: {
        get: async (defaults) => ({
          ...defaults,
          kualiPort: 9099,
          kualiPairingToken: "a".repeat(32),
        }),
      },
    },
    tabCapture: {
      getMediaStreamId(_options, callback) {
        callback("worker-minted-stream");
      },
    },
    tabs: {
      onRemoved: { addListener: (listener) => { listeners.removed = listener; } },
      onUpdated: { addListener: (listener) => { listeners.updated = listener; } },
      sendMessage: async (tabId, message) => {
        tabMessages.push({ tabId, message });
        if (message.type === "capture-identify") {
          return {
            platform: "google_meet",
            meetingId: "abc-defg-hij",
            title: "Test meeting",
          };
        }
        return undefined;
      },
    },
  }, originals);

  await import(`../src/background.js?capture-lifecycle=${Date.now()}-${Math.random()}`);

  async function start(message = {}) {
    listeners.runtime({
      type: "capture-start",
      tabId: 42,
      options: { screen: true },
      tabStreamId: "popup-stream",
      tabCaptureError: null,
      ...message,
    }, {}, () => {});
    await settle(() => sockets.length === 1);
    const socket = sockets[0];
    socket.onopen?.();
    await socket.onmessage({
      data: JSON.stringify({
        type: "ready",
        capture: {
          audio: true,
          screen: new URL(socket.url).searchParams.get("capture_screen") === "1",
          diagnostics: true,
        },
      }),
    });
    return socket;
  }

  return {
    listeners,
    runtimeMessages,
    tabMessages,
    sockets,
    timers,
    start,
    restore: () => restoreGlobals(originals),
  };
}

function meetingEvents(socket, kind) {
  return socket.sent
    .filter((value) => typeof value === "string")
    .map((value) => JSON.parse(value))
    .filter((event) => !kind || event.kind === kind);
}

test("a tabCapture rejection degrades to audio without ending the meeting", async () => {
  const harness = await backgroundHarness();
  try {
    const unsafeError = `  Not allowed\nby Chrome\u0000${"x".repeat(400)}  `;
    const socket = await harness.start({ tabStreamId: null, tabCaptureError: unsafeError });

    assert.equal(new URL(socket.url).searchParams.get("capture_screen"), "0");
    assert.equal(
      harness.runtimeMessages.some((message) => message.type === "mixed-capture-start"),
      false,
    );
    const status = harness.runtimeMessages
      .filter((message) => message.type === "capture-status")
      .at(-1);
    assert.equal(status.status, "capturing");
    assert.equal(status.error, null);
    assert.equal(status.capture.audio, true);
    assert.equal(status.capture.screen, false);
    assert.match(status.warning, /^Recording and transcribing audio only/);
    assert.doesNotMatch(status.warning, /[\u0000-\u001f\u007f]/);

    const degraded = meetingEvents(socket, "capture-degraded");
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0].detail.capability, "screen");
    assert.equal(degraded[0].detail.effective, false);
    assert(degraded[0].detail.reason.length <= 300);
    assert.deepEqual(meetingEvents(socket, "capture-options")[0].detail, {
      audio: true,
      screen: false,
      diagnostics: true,
    });
  } finally {
    harness.restore();
  }
});

test("worker recovery stops a same-tab orphan before restarting video", async () => {
  const harness = await backgroundHarness({ activeOffscreenTab: 42 });
  try {
    const socket = await harness.start();
    const stops = harness.runtimeMessages.filter((message) => message.type === "mixed-capture-stop");
    const starts = harness.runtimeMessages.filter((message) => message.type === "mixed-capture-start");
    assert.deepEqual(stops, [{ type: "mixed-capture-stop", tabId: 42 }]);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].tabId, 42);
    assert.equal(meetingEvents(socket, "capture-degraded").length, 0);
  } finally {
    harness.restore();
  }
});

test("worker recovery never stops an offscreen capture owned by another tab", async () => {
  const harness = await backgroundHarness({ activeOffscreenTab: 77 });
  try {
    const socket = await harness.start();
    assert.equal(
      harness.runtimeMessages.some((message) => message.type === "mixed-capture-stop"),
      false,
    );
    assert.equal(
      harness.runtimeMessages.some((message) => message.type === "mixed-capture-start"),
      false,
    );
    assert.equal(meetingEvents(socket, "capture-degraded").length, 1);
    const status = harness.runtimeMessages
      .filter((message) => message.type === "capture-status")
      .at(-1);
    assert.equal(status.status, "capturing");
    assert.equal(status.capture.screen, false);
  } finally {
    harness.restore();
  }
});

test("concurrent user stops finalize once and retain the explicit reason", async () => {
  const harness = await backgroundHarness();
  try {
    const socket = await harness.start();
    harness.listeners.runtime({ type: "capture-stop", tabId: 42, reason: "user" }, {}, () => {});
    harness.listeners.runtime({ type: "capture-stop", tabId: 42, reason: "user" }, {}, () => {});
    await settle(() => socket.readyState === 3);

    const stops = meetingEvents(socket, "capture-stop");
    assert.equal(stops.length, 1);
    assert.equal(stops[0].detail.reason, "user");
  } finally {
    harness.restore();
  }
});

test("starting over records restart before replacing the active socket", async () => {
  const harness = await backgroundHarness();
  try {
    const firstSocket = await harness.start();
    harness.listeners.runtime({
      type: "capture-start",
      tabId: 42,
      options: { screen: true },
      tabStreamId: "replacement-stream",
      tabCaptureError: null,
    }, {}, () => {});
    await settle(() => harness.sockets.length === 2);

    assert.equal(firstSocket.readyState, 3);
    const stops = meetingEvents(firstSocket, "capture-stop");
    assert.equal(stops.length, 1);
    assert.equal(stops[0].detail.reason, "restart");
  } finally {
    harness.restore();
  }
});

test("temporary Meet roster changes do not stop capture, but confirmed exit does", async () => {
  const harness = await backgroundHarness();
  try {
    const socket = await harness.start();
    const roster = (detail) => harness.listeners.runtime({
      type: "capture-event",
      tabId: 42,
      event: { type: "meeting-event", kind: "roster-state", detail },
    }, { frameId: 0 }, () => {});

    roster({ inCall: true, selfPresentInDom: true, participants: [{ isSelf: true }] });
    roster({ inCall: true, selfPresentInDom: false, participants: [] });
    assert.equal(harness.timers.filter((timer) => timer.delay === 3_500 && !timer.cancelled).length, 0);

    roster({ inCall: false, selfPresentInDom: false, participants: [] });
    const endTimer = harness.timers.find((timer) => timer.delay === 3_500 && !timer.cancelled);
    assert(endTimer, "confirmed Meet exit must schedule finalization");
    endTimer.callback();
    await settle(() => socket.readyState === 3);
    assert.equal(meetingEvents(socket, "capture-stop").at(-1).detail.reason, "meeting-left");
  } finally {
    harness.restore();
  }
});

test("tab closure and platform navigation use their diagnostic stop reasons", async (t) => {
  for (const scenario of [
    {
      name: "tab-closed",
      run: (listeners) => listeners.removed(42),
    },
    {
      name: "platform-navigation",
      run: (listeners) => listeners.updated(42, { url: "https://example.com/left" }),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const harness = await backgroundHarness();
      try {
        const socket = await harness.start();
        scenario.run(harness.listeners);
        await settle(() => socket.readyState === 3);
        assert.equal(meetingEvents(socket, "capture-stop").at(-1).detail.reason, scenario.name);
      } finally {
        harness.restore();
      }
    });
  }
});
