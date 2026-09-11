import assert from "node:assert/strict";
import test from "node:test";

test("capture state recovers the active tab after the service worker loses memory", async () => {
  let runtimeListener = null;
  const sentMessages = [];
  const addListener = () => {};
  globalThis.chrome = {
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    i18n: { getMessage: () => "" },
    runtime: {
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        },
      },
      sendMessage: async () => {},
    },
    storage: {
      local: {
        get: async (defaults) => defaults,
      },
    },
    tabs: {
      onRemoved: { addListener },
      onUpdated: { addListener },
      sendMessage: async (tabId, message, options) => {
        sentMessages.push({ tabId, message, options });
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
  };

  try {
    await import(`../src/background.js?recovery-test=${Date.now()}`);
    assert.equal(typeof runtimeListener, "function");

    const response = await new Promise((resolve) => {
      const keepOpen = runtimeListener(
        { type: "capture-state", tabId: 42 },
        {},
        resolve,
      );
      assert.equal(keepOpen, true);
    });

    assert.equal(response.platform, "microsoft_teams");
    assert.equal(response.status, "idle");
    assert.equal(response.pairingConfigured, false);
    assert.deepEqual(sentMessages[0], {
      tabId: 42,
      message: { type: "capture-identify" },
      options: { frameId: 0 },
    });
  } finally {
    delete globalThis.chrome;
  }
});
