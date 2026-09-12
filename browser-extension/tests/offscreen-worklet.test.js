import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("offscreen mixed capture uses the PCM AudioWorklet", async () => {
  const originals = new Map();
  const contexts = [];
  const worklets = [];
  const loadedModules = [];
  const sentMessages = [];
  let runtimeListener = null;

  const tabTrack = { kind: "audio", stop() {} };
  const tabStream = {
    getAudioTracks: () => [tabTrack],
    getTracks: () => [tabTrack],
    getVideoTracks: () => [],
  };

  class FakeAudioContext {
    constructor(options = {}) {
      this.options = options;
      this.currentTime = 0;
      this.destination = {};
      this.audioWorklet = {
        addModule: async (url) => loadedModules.push(url),
      };
      contexts.push(this);
    }

    createMediaStreamSource() {
      return { connect() {} };
    }

    async close() {}

    async resume() {}
  }

  class FakeAudioWorkletNode {
    constructor(context, name, options) {
      this.context = context;
      this.name = name;
      this.options = options;
      this.port = { onmessage: null };
      worklets.push(this);
    }

    connect() {}

    disconnect() {}
  }

  replaceGlobal("AudioContext", FakeAudioContext, originals);
  replaceGlobal("AudioWorkletNode", FakeAudioWorkletNode, originals);
  replaceGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => tabStream },
  }, originals);
  replaceGlobal("chrome", {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        },
      },
      sendMessage: async (message) => {
        sentMessages.push(message);
      },
    },
  }, originals);

  try {
    await import(`../src/offscreen.js?worklet-test=${Date.now()}`);
    assert.equal(typeof runtimeListener, "function");
    const response = await new Promise((resolve) => {
      assert.equal(runtimeListener({
        type: "mixed-capture-start",
        streamId: "tab-stream",
        tabId: 42,
        recordScreen: false,
      }, {}, resolve), true);
    });

    assert.deepEqual(response, { ok: true });
    assert.equal(contexts.length, 2);
    assert.deepEqual(loadedModules, ["chrome-extension://test/src/pcm-worklet.js"]);
    assert.equal(worklets.length, 1);
    assert.equal(worklets[0].name, "kuali-pcm");
    assert.equal(worklets[0].options.channelCount, 1);
    assert.equal(worklets[0].options.channelCountMode, "explicit");
    assert.equal(worklets[0].options.channelInterpretation, "speakers");
    assert.equal(typeof worklets[0].port.onmessage, "function");

    worklets[0].port.onmessage({
      data: new Float32Array(2048).fill(0.1).buffer,
    });
    await Promise.resolve();
    const mixedAudio = sentMessages.find((message) => message.type === "mixed-audio");
    assert.equal(mixedAudio?.tabId, 42);
    assert.equal(mixedAudio?.pcm.length, 2048);
    assert(Math.abs(mixedAudio.pcm[0] - 0.1) < 1e-6);

    const stopped = await new Promise((resolve) => {
      assert.equal(runtimeListener({ type: "mixed-capture-stop" }, {}, resolve), true);
    });
    assert.deepEqual(stopped, { ok: true });

    const source = readFileSync(new URL("../src/offscreen.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /createScriptProcessor|onaudioprocess/);
  } finally {
    restoreGlobals(originals);
  }
});
