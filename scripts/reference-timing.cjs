function deadlineDelay(clickTime, elapsed, now) {
  return Math.max(0, clickTime + elapsed - now);
}

function timingObservation(elapsed, clickTime, observedAt, tolerance) {
  const timingErrorMs = observedAt - clickTime - elapsed;
  return { timingErrorMs, withinTolerance: Math.abs(timingErrorMs) <= tolerance };
}

module.exports = { deadlineDelay, timingObservation };
