// Robust biphase-mark edge decoder shared by the main thread and LTC worker.
// It keeps the existing API shape but replaces brittle hard thresholds with a
// timing-cost decision, a small PLL, and a guarded spurious-edge merge.
export function decodeLtcEdgesRobust(edges, expectedHalfBitSamples) {
  const bits = [];
  const bitStarts = [];
  const bitEnds = [];
  const observedHalves = [];
  if (!edges?.length || !Number.isFinite(expectedHalfBitSamples) || expectedHalfBitSamples <= 0) {
    return {
      bits,
      bitStarts,
      bitEnds,
      rejected: 0,
      trackedHalfBitSamples: expectedHalfBitSamples,
      observedHalfBitSamples: expectedHalfBitSamples,
      observedJitter: 1,
      observedCount: 0,
    };
  }
  const nominal = expectedHalfBitSamples;
  let half = nominal;
  let rejected = 0;
  let i = 0;
  const maxDrift = nominal * 0.16;
  const timingCost = (value, target) => {
    if (!Number.isFinite(value) || value <= 0) return 99;
    const ratio = value / target;
    return Math.abs(Math.log(ratio)) + Math.max(0, Math.abs(ratio - 1) - 0.075) * 1.8;
  };
  const updateClock = value => {
    if (!Number.isFinite(value) || value <= 0) return;
    const bounded = Math.max(nominal - maxDrift, Math.min(nominal + maxDrift, value));
    half += (bounded - half) * 0.035;
  };
  while (i < edges.length - 1) {
    const d1 = edges[i + 1] - edges[i];
    const candidates = [];
    if (d1 > half * 0.42 && d1 < half * 3.5) {
      candidates.push({ bit: 0, consume: 1, observed: d1 / 2, cost: timingCost(d1 / 2, half), start: edges[i], end: edges[i + 1] });
    }
    if (i + 2 < edges.length) {
      const d2 = edges[i + 2] - edges[i + 1];
      if (d1 > half * 0.42 && d1 < half * 2.15 && d2 > half * 0.42 && d2 < half * 2.15) {
        const observed = (d1 + d2) / 2;
        candidates.push({ bit: 1, consume: 2, observed, cost: (timingCost(d1, half) + timingCost(d2, half)) / 2 + Math.abs(d1 - d2) / Math.max(half, 1) * 0.08, start: edges[i], end: edges[i + 2] });
        const combined = (d1 + d2) / 2;
        if (Math.min(d1, d2) < half * 0.78 && combined > half * 0.82 && combined < half * 1.18) {
          candidates.push({ bit: 0, consume: 2, observed: combined, cost: timingCost(combined, half) + 0.18, start: edges[i], end: edges[i + 2], merged: true });
        }
      }
    }
    if (!candidates.length) { rejected++; i++; continue; }
    candidates.sort((a, b) => a.cost - b.cost);
    const selected = candidates[0];
    if (selected.cost > 1.05 && candidates[1]?.cost > selected.cost * 0.82) { rejected++; i++; continue; }
    bits.push(selected.bit);
    bitStarts.push(selected.start);
    bitEnds.push(selected.end);
    if (selected.bit === 1) {
      observedHalves.push(edges[i + 1] - edges[i], edges[i + 2] - edges[i + 1]);
    } else {
      observedHalves.push(selected.observed);
    }
    updateClock(selected.observed);
    i += selected.consume;
  }
  const observedMean = observedHalves.length
    ? observedHalves.reduce((sum, value) => sum + value, 0) / observedHalves.length
    : half;
  const observedJitter = observedHalves.length
    ? Math.sqrt(observedHalves.reduce((sum, value) => sum + (value - observedMean) ** 2, 0) / observedHalves.length) / Math.max(observedMean, 1)
    : 1;
  return {
    bits,
    bitStarts,
    bitEnds,
    rejected,
    trackedHalfBitSamples: half,
    observedHalfBitSamples: observedMean,
    observedJitter,
    observedCount: observedHalves.length,
  };
}
