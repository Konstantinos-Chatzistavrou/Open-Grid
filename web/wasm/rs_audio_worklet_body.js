// Apache-2.0 — OpenGrid AudioWorkletProcessor wrapping rs_audio.wasm (appended to Emscripten shell module).
if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  class OpenGridVehicleAudioProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.mod = null;
      this.ready = false;
      this.telPtr = 0;
      this.outLPtr = 0;
      this.outRPtr = 0;
      this.pendingTel = null;
      this.active = false;
      this.port.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg) return;
        if (msg.type === 'init') {
          void this._initWasm(msg);
        } else if (msg.type === 'voice' && this.ready && this.mod) {
          this.mod._rsa_set_voice(msg.voiceId | 0, msg.exhaustStage | 0, msg.turboEnabled ? 1 : 0);
        } else if (msg.type === 'telemetry' && msg.data) {
          this.pendingTel = msg.data;
          this.active = msg.active !== false;
        } else if (msg.type === 'active') {
          this.active = !!msg.active;
        } else if (msg.type === 'trigger' && this.ready && this.mod) {
          if (msg.kind === 'pop') this.mod._rsa_trigger_pop(msg.value ?? 0.85);
          else if (msg.kind === 'flutter') this.mod._rsa_trigger_flutter(msg.value ?? 1.0);
          else if (msg.kind === 'crank') this.mod._rsa_trigger_crank(msg.value ?? 0.42);
          else if (msg.kind === 'burble') this.mod._rsa_trigger_burble(msg.value ?? 0.55);
          else if (msg.kind === 'impact') this.mod._rsa_trigger_impact(msg.value ?? 8.0);
        }
      };
    }

    async _initWasm(msg) {
      try {
        const bytes = new Uint8Array(msg.wasmBinary);
        const m = await createRsAudio({
          instantiateWasm(imports, receiveInstance) {
            WebAssembly.instantiate(bytes, imports).then((res) => receiveInstance(res.instance));
            return {};
          },
        });
        const ok = m._rsa_init(
          msg.voiceId | 0,
          Math.round(sampleRate || 48000),
          msg.simFreq || 4000,
          msg.fluidSubsteps || 3,
          msg.exhaustStage | 0,
          msg.turboEnabled ? 1 : 0,
        );
        if (!ok) {
          this.port.postMessage({ type: 'error', error: 'rsa_init returned 0' });
          return;
        }
        this.mod = m;
        this.telPtr = m._rsa_telemetry_ptr() >> 2;
        this.outLPtr = m._rsa_out_l_ptr() >> 2;
        this.outRPtr = m._rsa_out_r_ptr() >> 2;
        this.ready = true;
        this.port.postMessage({ type: 'ready' });
      } catch (err) {
        this.port.postMessage({ type: 'error', error: String(err) });
      }
    }

    process(_inputs, outputs) {
      const out = outputs[0];
      if (!out || out.length === 0) return true;
      const outL = out[0];
      const outR = out[1] || out[0];
      const n = outL.length;

      if (!this.ready || !this.mod || !this.active) {
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
        return true;
      }

      const heap = this.mod.HEAPF32;
      if (this.pendingTel) {
        heap.set(this.pendingTel, this.telPtr);
        this.pendingTel = null;
        this.mod._rsa_apply_telemetry();
      }
      this.mod._rsa_render(n);
      const h2 = this.mod.HEAPF32;
      const lBase = this.outLPtr;
      const rBase = this.outRPtr;
      for (let i = 0; i < n; i++) {
        outL[i] = h2[lBase + i];
        if (outR !== outL) outR[i] = h2[rBase + i];
      }
      return true;
    }
  }

  registerProcessor('opengrid-vehicle-audio', OpenGridVehicleAudioProcessor);
}
