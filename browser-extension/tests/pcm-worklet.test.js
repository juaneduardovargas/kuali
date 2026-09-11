import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("the PCM worklet preserves speech present only on the second webcam channel", () => {
  let Processor = null;
  class AudioWorkletProcessor {
    constructor() {
      this.port = {
        messages: [],
        postMessage: (value) => this.port.messages.push(new Float32Array(value)),
      };
    }
  }
  const source = readFileSync(new URL("../src/pcm-worklet.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    Float32Array,
    Math,
    registerProcessor(_name, constructor) {
      Processor = constructor;
    },
  });

  const processor = new Processor();
  for (let block = 0; block < 16; block += 1) {
    processor.process([[
      new Float32Array(128),
      new Float32Array(128).fill(0.2),
    ]]);
  }

  assert.equal(processor.port.messages.length, 1);
  assert.equal(processor.port.messages[0].length, 2048);
  assert(Math.abs(processor.port.messages[0][0] - 0.2) < 1e-6);
});
