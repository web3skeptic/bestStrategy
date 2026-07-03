// Minimal fully-connected MLP with tanh activations, MSE loss and Adam.
// Pure JS (Float64Array), no deps — used as the VALUE network V(features)≈±1.
// Alloc-free hot path: forward/backward reuse preallocated scratch buffers so
// training and 1-ply-lookahead inference don't churn the GC.
import { writeFileSync, readFileSync } from 'fs';

function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface Layer {
  inN: number; outN: number;
  W: Float64Array; b: Float64Array;
  mW: Float64Array; vW: Float64Array; mb: Float64Array; vb: Float64Array;
  gW: Float64Array; gb: Float64Array;   // grad accumulators (per batch)
  z: Float64Array;                       // activation output (scratch)
  d: Float64Array;                       // delta (scratch)
}

export class MLP {
  layers: Layer[];
  sizes: number[];
  t = 0;
  lr: number;
  constructor(sizes: number[], lr = 1e-3) {
    this.sizes = sizes.slice();
    this.lr = lr;
    this.layers = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const inN = sizes[l]!, outN = sizes[l + 1]!;
      const W = new Float64Array(outN * inN);
      const scale = Math.sqrt(2 / (inN + outN));
      for (let i = 0; i < W.length; i++) W[i] = randn() * scale;
      this.layers.push({
        inN, outN, W, b: new Float64Array(outN),
        mW: new Float64Array(outN * inN), vW: new Float64Array(outN * inN),
        mb: new Float64Array(outN), vb: new Float64Array(outN),
        gW: new Float64Array(outN * inN), gb: new Float64Array(outN),
        z: new Float64Array(outN), d: new Float64Array(outN),
      });
    }
  }

  // Forward pass (alloc-free). Input is read, not modified. Returns the last
  // layer's activation buffer (do NOT retain it across calls — it's scratch).
  forward(x: ArrayLike<number>): Float64Array {
    let a: ArrayLike<number> = x;
    const last = this.layers.length - 1;
    for (let l = 0; l < this.layers.length; l++) {
      const L = this.layers[l]!;
      const W = L.W, b = L.b, z = L.z, inN = L.inN, outN = L.outN;
      const isLast = l === last;
      for (let o = 0; o < outN; o++) {
        let s = b[o]!;
        const base = o * inN;
        for (let i = 0; i < inN; i++) s += W[base + i]! * (a[i] as number);
        // Hidden layers: tanh. Output layer: LINEAR (no saturation → smooth value
        // gradient for 1-ply lookahead; the greedy-improve bot needs to tell
        // action-values apart).
        z[o] = isLast ? s : Math.tanh(s);
      }
      a = z;
    }
    return this.layers[last]!.z;
  }

  value(x: ArrayLike<number>): number { return this.forward(x)[0]!; }

  private zeroGrads() { for (const L of this.layers) { L.gW.fill(0); L.gb.fill(0); } }

  // One Adam step on a minibatch. Single scalar output. Returns MSE.
  trainBatch(xs: ArrayLike<number>[], ys: number[], lr = this.lr): number {
    const B = xs.length;
    this.zeroGrads();
    let loss = 0;
    const last = this.layers.length - 1;
    for (let n = 0; n < B; n++) {
      const x = xs[n]!;
      this.forward(x);
      const yhat = this.layers[last]!.z[0]!;
      const err = yhat - ys[n]!;
      loss += err * err;
      // output delta (LINEAR output → derivative 1)
      this.layers[last]!.d[0] = err;
      for (let l = last; l >= 0; l--) {
        const L = this.layers[l]!;
        const aIn: ArrayLike<number> = l === 0 ? x : this.layers[l - 1]!.z;
        const d = L.d, gW = L.gW, gb = L.gb, inN = L.inN, outN = L.outN;
        for (let o = 0; o < outN; o++) {
          const dv = d[o]!;
          gb[o]! += dv;
          const base = o * inN;
          for (let i = 0; i < inN; i++) gW[base + i]! += dv * (aIn[i] as number);
        }
        if (l > 0) {
          const prev = this.layers[l - 1]!;
          const pd = prev.d, pz = prev.z, W = L.W;
          for (let i = 0; i < inN; i++) {
            let s = 0;
            for (let o = 0; o < outN; o++) s += d[o]! * W[o * inN + i]!;
            pd[i] = s * (1 - pz[i]! * pz[i]!);
          }
        }
      }
    }
    // Adam
    this.t++;
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    const bc1 = 1 - Math.pow(b1, this.t), bc2 = 1 - Math.pow(b2, this.t);
    const scale = 1 / B;
    for (const L of this.layers) {
      for (let k = 0; k < L.W.length; k++) {
        const g = L.gW[k]! * scale;
        L.mW[k] = b1 * L.mW[k]! + (1 - b1) * g;
        L.vW[k] = b2 * L.vW[k]! + (1 - b2) * g * g;
        L.W[k]! -= lr * (L.mW[k]! / bc1) / (Math.sqrt(L.vW[k]! / bc2) + eps);
      }
      for (let o = 0; o < L.b.length; o++) {
        const g = L.gb[o]! * scale;
        L.mb[o] = b1 * L.mb[o]! + (1 - b1) * g;
        L.vb[o] = b2 * L.vb[o]! + (1 - b2) * g * g;
        L.b[o]! -= lr * (L.mb[o]! / bc1) / (Math.sqrt(L.vb[o]! / bc2) + eps);
      }
    }
    return loss / B;
  }

  // ── Generic gradient API (used by the policy head's softmax cross-entropy) ──
  // The value net uses trainBatch (MSE). The policy net needs to backprop an
  // arbitrary output gradient per (state⊕action) input and pool grads over a
  // variable-size candidate set, so expose beginBatch / accumulate / step.

  beginBatch(): void { this.zeroGrads(); }

  // Forward `x`, then backprop from scalar output gradient dOut (= dLoss/dLogit),
  // accumulating parameter grads (no Adam step). Output head is LINEAR, so the
  // output delta is exactly dOut. Returns the forward logit. Re-forwards its own
  // input, so it is safe to call per-candidate after a separate scoring pass.
  accumulate(x: ArrayLike<number>, dOut: number): number {
    this.forward(x);
    const last = this.layers.length - 1;
    const logit = this.layers[last]!.z[0]!;
    this.layers[last]!.d[0] = dOut;
    for (let l = last; l >= 0; l--) {
      const L = this.layers[l]!;
      const aIn: ArrayLike<number> = l === 0 ? x : this.layers[l - 1]!.z;
      const d = L.d, gW = L.gW, gb = L.gb, inN = L.inN, outN = L.outN;
      for (let o = 0; o < outN; o++) {
        const dv = d[o]!;
        gb[o]! += dv;
        const base = o * inN;
        for (let i = 0; i < inN; i++) gW[base + i]! += dv * (aIn[i] as number);
      }
      if (l > 0) {
        const prev = this.layers[l - 1]!;
        const pd = prev.d, pz = prev.z, W = L.W;
        for (let i = 0; i < inN; i++) {
          let s = 0;
          for (let o = 0; o < outN; o++) s += d[o]! * W[o * inN + i]!;
          pd[i] = s * (1 - pz[i]! * pz[i]!);
        }
      }
    }
    return logit;
  }

  // Adam update from accumulated grads, averaged over B (e.g. #decisions/batch).
  step(lr = this.lr, B = 1): void {
    this.t++;
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    const bc1 = 1 - Math.pow(b1, this.t), bc2 = 1 - Math.pow(b2, this.t);
    const scale = 1 / B;
    for (const L of this.layers) {
      for (let k = 0; k < L.W.length; k++) {
        const g = L.gW[k]! * scale;
        L.mW[k] = b1 * L.mW[k]! + (1 - b1) * g;
        L.vW[k] = b2 * L.vW[k]! + (1 - b2) * g * g;
        L.W[k]! -= lr * (L.mW[k]! / bc1) / (Math.sqrt(L.vW[k]! / bc2) + eps);
      }
      for (let o = 0; o < L.b.length; o++) {
        const g = L.gb[o]! * scale;
        L.mb[o] = b1 * L.mb[o]! + (1 - b1) * g;
        L.vb[o] = b2 * L.vb[o]! + (1 - b2) * g * g;
        L.b[o]! -= lr * (L.mb[o]! / bc1) / (Math.sqrt(L.vb[o]! / bc2) + eps);
      }
    }
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify({
      sizes: this.sizes, t: this.t, lr: this.lr,
      layers: this.layers.map(L => ({ W: Array.from(L.W), b: Array.from(L.b) })),
    }));
  }

  static load(path: string): MLP {
    const d = JSON.parse(readFileSync(path, 'utf8'));
    const net = new MLP(d.sizes, d.lr ?? 1e-3);
    net.t = d.t ?? 0;
    d.layers.forEach((L: { W: number[]; b: number[] }, i: number) => {
      net.layers[i]!.W = Float64Array.from(L.W);
      net.layers[i]!.b = Float64Array.from(L.b);
    });
    return net;
  }
}
