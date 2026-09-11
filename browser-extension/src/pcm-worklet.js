/* Copyright 2026 Kuali contributors · SPDX-License-Identifier: Apache-2.0 */
class KualiPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
    this.peak = 0;
  }

  process(inputs) {
    const channels = inputs[0] || [];
    const input = channels[0];
    if (!input || channels.length === 0) return true;
    let selected = input;
    let selectedEnergy = -1;
    for (const channel of channels) {
      let energy = 0;
      for (let index = 0; index < channel.length; index += 1) {
        energy += channel[index] * channel[index];
      }
      if (energy > selectedEnergy) {
        selected = channel;
        selectedEnergy = energy;
      }
    }
    let at = 0;
    while (at < input.length) {
      const count = Math.min(input.length - at, this.buffer.length - this.offset);
      // USB webcams commonly expose stereo input with speech present on only
      // one side. Select the loudest complete render block so that we preserve
      // its waveform instead of averaging phase-opposed microphones to silence.
      this.buffer.set(selected.subarray(at, at + count), this.offset);
      for (let index = at; index < at + count; index += 1) {
        this.peak = Math.max(this.peak, Math.abs(selected[index]));
      }
      this.offset += count;
      at += count;
      if (this.offset === this.buffer.length) {
        if (this.peak >= 0.0005) this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048);
        this.offset = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor("kuali-pcm", KualiPcmProcessor);
