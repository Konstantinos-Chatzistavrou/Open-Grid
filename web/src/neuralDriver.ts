// Apache-2.0 — Open Grid Neural Driver TypeScript Inference Loader.
// Zero external dependencies, zero per-tick heap allocations, exact parity with
// core/src/neural_driver.cpp (14 -> 48 tanh -> 32 tanh -> 3 tanh / 0.5+0.5*tanh).
// Loads /assets/ai/neural_driver.json lazily once; fails gracefully if offline.

export const NEURAL_OBS_DIM = 14;
export const NEURAL_H1_DIM = 48;
export const NEURAL_H2_DIM = 32;
export const NEURAL_ACT_DIM = 3;

export interface NeuralActionOut {
  /** Normalized steering in [-1, 1] (+ = left, - = right). */
  steer: number;
  /** Normalized throttle in [0, 1]. */
  throttle: number;
  /** Normalized brake in [0, 1]. */
  brake: number;
}

interface NeuralWeightsJson {
  schema?: string;
  arch?: number[];
  w1: number[];
  b1: number[];
  w2: number[];
  b2: number[];
  w3: number[];
  b3: number[];
}

export class NeuralDriverPolicy {
  ready = false;
  private w1 = new Float64Array(NEURAL_H1_DIM * NEURAL_OBS_DIM);
  private b1 = new Float64Array(NEURAL_H1_DIM);
  private w2 = new Float64Array(NEURAL_H2_DIM * NEURAL_H1_DIM);
  private b2 = new Float64Array(NEURAL_H2_DIM);
  private w3 = new Float64Array(NEURAL_ACT_DIM * NEURAL_H2_DIM);
  private b3 = new Float64Array(NEURAL_ACT_DIM);
  private h1 = new Float64Array(NEURAL_H1_DIM);
  private h2 = new Float64Array(NEURAL_H2_DIM);
  private loadPromise: Promise<boolean> | null = null;

  /** Parse weights from an already-fetched JSON object. Returns true if valid. */
  loadFromJson(data: NeuralWeightsJson): boolean {
    if (
      !data
      || !Array.isArray(data.w1) || data.w1.length !== this.w1.length
      || !Array.isArray(data.b1) || data.b1.length !== this.b1.length
      || !Array.isArray(data.w2) || data.w2.length !== this.w2.length
      || !Array.isArray(data.b2) || data.b2.length !== this.b2.length
      || !Array.isArray(data.w3) || data.w3.length !== this.w3.length
      || !Array.isArray(data.b3) || data.b3.length !== this.b3.length
    ) {
      return false;
    }
    this.w1.set(data.w1);
    this.b1.set(data.b1);
    this.w2.set(data.w2);
    this.b2.set(data.b2);
    this.w3.set(data.w3);
    this.b3.set(data.b3);
    this.ready = true;
    return true;
  }

  /** Lazily fetch trained Open Grid Neural Driver weights once; safe & silent when offline. */
  load(url = '/assets/ai/neural_driver.json'): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.loadPromise) return this.loadPromise;
    if (typeof fetch !== 'function') return Promise.resolve(false);
    this.loadPromise = fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: NeuralWeightsJson | null) => (json ? this.loadFromJson(json) : false))
      .catch(() => false);
    return this.loadPromise;
  }

  /** Zero-allocation deterministic forward pass matching core/src/neural_driver.cpp 1:1. */
  infer(obs: ArrayLike<number>, out: NeuralActionOut): NeuralActionOut {
    const { w1, b1, w2, b2, w3, b3, h1, h2 } = this;

    for (let i = 0; i < NEURAL_H1_DIM; i++) {
      let acc = b1[i];
      const row = i * NEURAL_OBS_DIM;
      for (let j = 0; j < NEURAL_OBS_DIM; j++) {
        acc += w1[row + j] * obs[j];
      }
      h1[i] = Math.tanh(acc);
    }

    for (let i = 0; i < NEURAL_H2_DIM; i++) {
      let acc = b2[i];
      const row = i * NEURAL_H1_DIM;
      for (let j = 0; j < NEURAL_H1_DIM; j++) {
        acc += w2[row + j] * h1[j];
      }
      h2[i] = Math.tanh(acc);
    }

    let z0 = b3[0];
    let z1 = b3[1];
    let z2 = b3[2];
    for (let j = 0; j < NEURAL_H2_DIM; j++) {
      const hj = h2[j];
      z0 += w3[j] * hj;
      z1 += w3[NEURAL_H2_DIM + j] * hj;
      z2 += w3[2 * NEURAL_H2_DIM + j] * hj;
    }

    out.steer = Math.tanh(z0);
    out.throttle = 0.5 + 0.5 * Math.tanh(z1);
    out.brake = 0.5 + 0.5 * Math.tanh(z2);
    return out;
  }
}

let sharedPolicy: NeuralDriverPolicy | null = null;

/** Shared Open Grid Neural Driver singleton (kicks off lazy fetch once in browser). */
export function getNeuralDriver(url = '/assets/ai/neural_driver.json'): NeuralDriverPolicy {
  if (!sharedPolicy) {
    sharedPolicy = new NeuralDriverPolicy();
    void sharedPolicy.load(url);
  }
  return sharedPolicy;
}
