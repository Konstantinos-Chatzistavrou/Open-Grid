// CC0-1.0. A simple bot that gets round cleanly: Stanley-style steering (curvature feed-forward plus heading and
// lateral-offset correction) and a speed target from the tightest corner ahead it can still brake for.
// It drives at 80% of the grip on purpose; push lateralG towards 1 and it starts to spin. Copy it, beat it.
// Observation fields: harness.d.ts (BotObservation). Car frame: x = left, z = forward. Steer + = left.

export function createExampleBot({ lateralG = 0.8, brakeG = 0.8, headingGain = 1.0, lateralGain = 1.2, feedForwardTime = 0.25 } = {}) {
  let wheelbase = 2.6, maxSteer = (32 * Math.PI) / 180;

  // route curvature at a distance ahead, interpolated between the observation's lookahead points
  function curvatureAt(o, d) {
    let i = o.ahead.findIndex((p) => p.distance >= d);
    if (i < 0) i = o.ahead.length - 1;
    const b = o.ahead[i], a = i > 0 ? o.ahead[i - 1] : { distance: 0, curvature: b.curvature };
    const f = Math.max(0, Math.min(1, (d - a.distance) / Math.max(1e-6, b.distance - a.distance)));
    return a.curvature + (b.curvature - a.curvature) * f;
  }

  return {
    name: 'example-bot',
    reset({ car }) {
      wheelbase = car.wheelbase || wheelbase;
      maxSteer = ((car.maxSteerDeg || 32) * Math.PI) / 180;
    },
    drive(o) {
      const g = 9.81, v = Math.max(0, o.speed);

      // Steering: the angle that follows the curve ahead, minus corrections for pointing the wrong way and for
      // being off the centreline (+ lateral = left of it, so steer right).
      const k = curvatureAt(o, Math.max(5, v * feedForwardTime));
      const delta = Math.atan(wheelbase * k) - headingGain * o.headingError - Math.atan((lateralGain * o.lateral) / (v + 3));
      const steer = Math.max(-1, Math.min(1, delta / maxSteer));

      // Speed: the slowest of (corner speed + braking distance available) over the points ahead.
      let vTarget = Infinity;
      for (const p of o.ahead) {
        const kp = Math.abs(p.curvature);
        if (kp < 1e-4) continue;
        vTarget = Math.min(vTarget, Math.sqrt((lateralG * g) / kp + 2 * brakeG * g * Math.max(0, p.distance - 5)));
      }
      const err = vTarget - v;
      const throttle = err > 0 ? Math.min(1, err / 4) : 0;
      const brake = err < -1 ? Math.min(1, -err / 6) : 0;
      return { steer, throttle, brake };
    },
  };
}

export default createExampleBot;
