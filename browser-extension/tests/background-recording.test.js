import assert from "node:assert/strict";
import test from "node:test";

function replaceGlobal(name, value, originals) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreGlobals(originals) {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}

test("screen recording forwards local PCM with its declared sample rate", async () => {
  const originals = new Map();
  let runtimeListener = null;
  const runtimeMessages = [];
  const sockets = [];
  const pairingToken = "a".repeat(32);

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

  const addListener = () => {};
  replaceGlobal("WebSocket", FakeWebSocket, originals);
  replaceGlobal("setInterval", () => 1, originals);
  replaceGlobal("chrome", {
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    i18n: { getMessage: () => "" },
    offscreen: { createDocument: async () => {} },
    runtime: {
      getContexts: async () => [],
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        },
      },
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        if (message.type === "mixed-capture-start") return { ok: true };
        return undefined;
      },
    },
    storage: {
      local: {
        get: async (defaults) => ({
          ...defaults,
          kualiPort: 9099,
          kualiPairingToken: pairingToken,
        }),
      },
    },
    tabCapture: {
      getMediaStreamId(_options, callback) {
        callback("test-tab-stream");
      },
    },
    tabs: {
      onRemoved: { addListener },
      onUpdated: { addListener },
      sendMessage: async (_tabId, message) => {
        if (message.type === "capture-identify") {
          return {
            platform: "microsoft_teams",
            meetingId: "test-meeting",
            title: "Test meeting",
          };
        }
        return undefined;
      },
    },
  }, originals);

  try {
    await import(`../src/background.js?recording-test=${Date.now()}`);
    assert.equal(typeof runtimeListener, "function");

    runtimeListener(
      { type: "capture-start", tabId: 42, options: { screen: true } },
      {},
      () => {},
    );
    for (let attempt = 0; attempt < 12 && sockets.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    assert.equal(sockets.length, 1);
    const socket = sockets[0];
    socket.onopen?.();
    await socket.onmessage({
      data: JSON.stringify({
        type: "ready",
        capture: { audio: true, screen: true, diagnostics: true },
      }),
    });

    assert.doesNotThrow(() => runtimeListener(
      {
        type: "capture-event",
        tabId: 42,
        event: { type: "audio", channel: 1000, ts: 1234, pcm: [0.1, -0.1] },
      },
      { frameId: 0 },
      () => {},
    ));
    assert.deepEqual(
      runtimeMessages.find((message) => message.type === "recording-microphone-pcm"),
      {
        type: "recording-microphone-pcm",
        tabId: 42,
        ts: 1234,
        sampleRate: 16_000,
        pcm: [0.1, -0.1],
      },
    );
  } finally {
    restoreGlobals(originals);
  }
});
