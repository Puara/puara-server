// JS ports of the puara-gestures descriptors, so the phone computes the same
// signals an ESP32-based Puara instrument would.
//
// Reference: https://github.com/Puara/puara-gestures
//   include/puara/utils/leakyintegrator.h
//   include/puara/descriptors/shake.h
//   include/puara/descriptors/jab.h
//   include/puara/descriptors/brushRub.h
//   include/puara/descriptors/button.h
//
// Arithmetic, constants and state-machine order follow the C++ line by line.
// Two deliberate deviations, both marked DEVIATION below: the C++ zeroes a
// descriptor's output without zeroing the integrator behind it, so the next
// sample resurrects the old value from `old_value`. Reaching a true 0 when the
// gesture stops is the whole point here, so both are reset together.
//
// `now` is milliseconds from a monotonic clock (`performance.now()`), passed in
// rather than read internally so callers can drive these at a fixed tick.

// utils/leakyintegrator.h
export class LeakyIntegrator {
  constructor({ value = 0, leak = 0.5, frequency = 100 } = {}) {
    this.currentValue = value;
    this.oldValue = 0;
    this.leak = leak;
    this.frequency = frequency;
    this.timer = 0;
  }

  integrate(reading, leak = this.leak, now = 0) {
    if (this.frequency <= 0) {
      this.currentValue = reading + this.oldValue * leak;
    } else if (now - 1000 / this.frequency < this.timer) {
      // inside the leak period: accumulate without leaking
      this.currentValue = reading + this.oldValue;
    } else {
      this.currentValue = reading + this.oldValue * leak;
      this.timer = now;
    }
    this.oldValue = this.currentValue;
    return this.currentValue;
  }

  reset() {
    this.currentValue = 0;
    this.oldValue = 0;
  }
}

// descriptors/shake.h — energy that accumulates while shaking and decays after.
export class Shake {
  constructor({ threshold = 0.1, fastLeak = 0.6, slowLeak = 0.3, frequency = 10 } = {}) {
    this.integrator = new LeakyIntegrator({ leak: fastLeak, frequency });
    this.threshold = threshold;
    this.fastLeak = fastLeak;
    this.slowLeak = slowLeak;
  }

  update(reading, now) {
    const absReading = Math.abs(reading);

    if (absReading > this.threshold) {
      this.integrator.integrate(absReading / 10, this.fastLeak, now);
    } else {
      this.integrator.integrate(0, this.slowLeak, now);
      if (this.integrator.currentValue < this.threshold / 10) {
        // DEVIATION: C++ clears current_value only, leaving old_value primed to
        // bring the energy straight back on the next sample.
        this.integrator.reset();
      }
    }

    return this.integrator.currentValue;
  }

  get value() {
    return this.integrator.currentValue;
  }
}

// descriptors/jab.h — signed span of a rolling window, latched until the next
// jab exceeds the threshold (the C++ never decays `value` either).
export class Jab {
  constructor({ threshold = 5, window = 10 } = {}) {
    this.threshold = threshold;
    this.window = window;
    this.buffer = [];
    this.value = 0;
  }

  update(reading) {
    this.buffer.push(reading);
    while (this.buffer.length > this.window) {
      this.buffer.shift();
    }

    let min = this.buffer[0];
    let max = this.buffer[0];
    for (const sample of this.buffer) {
      if (sample < min) {
        min = sample;
      }
      if (sample > max) {
        max = sample;
      }
    }

    if (max - min > this.threshold) {
      if (max < 0 && min < 0) {
        this.value = min - max;
      } else {
        this.value = max - min;
      }
    }

    return this.value;
  }
}

// descriptors/brushRub.h — ValueIntegrator over a *position*, so the input is
// where the finger is and the descriptor works on the frame-to-frame delta.
class ValueIntegrator {
  constructor({ leak = 0.7, frequency = 100, scale = 0.15 } = {}) {
    this.integrator = new LeakyIntegrator({ leak, frequency });
    this.scale = scale;
    this.value = 0;
    this.prevValue = 0;
    this.counter = 0;
  }

  update(newValue, now) {
    const delta = newValue - this.prevValue;
    this.prevValue = newValue;

    if (delta === 0) {
      // only give up after 10 consecutive still samples
      if (++this.counter < 10) {
        return this.value;
      }
      if (this.value < 0.001) {
        this.reset();
      } else {
        this.integrate(delta, now);
      }
    } else if (Math.abs(delta) > 1) {
      // teleport (new finger, pointer swap): integrate nothing
      this.integrate(0, now);
    } else {
      this.integrate(delta, now);
      this.counter = 0;
    }

    return this.value;
  }

  reset() {
    this.value = 0;
    // DEVIATION: C++ reset() leaves the integrator holding its last value.
    this.integrator.reset();
  }

  integrate() {
    throw new Error('ValueIntegrator.integrate is abstract');
  }
}

export class Brush extends ValueIntegrator {
  integrate(movement, now) {
    this.value = this.integrator.integrate(movement * this.scale, undefined, now);
  }
}

export class Rub extends ValueIntegrator {
  integrate(movement, now) {
    this.value = this.integrator.integrate(Math.abs(movement) * this.scale, undefined, now);
  }
}

// descriptors/button.h — tap / double tap / triple tap / hold state machine.
export class Button {
  constructor({ countInterval = 200, holdInterval = 5000 } = {}) {
    this.countInterval = countInterval;
    this.holdInterval = holdInterval;
    this.timer = 0;
    this.count = 0;
    this.press = false;
    this.tap = 0;
    this.doubleTap = 0;
    this.tripleTap = 0;
    this.hold = false;
    this.pressTime = 0;
  }

  update(value, now) {
    if (value) {
      if (!this.press) {
        this.press = true;
        this.timer = now;
      }
      if (now - this.timer > this.holdInterval) {
        this.hold = true;
      }
    } else if (this.hold) {
      this.hold = false;
      this.press = false;
      // -1 so the release that ended the hold is not also counted as a tap;
      // the C++ relies on unsigned wraparound plus the ++ below for this.
      this.count = -1;
    } else if (this.press) {
      this.press = false;
      this.pressTime = now - this.timer;
      this.timer = now;
      this.count += 1;
    }

    if (!this.press && now - this.timer > this.countInterval) {
      switch (this.count) {
        case 1:
          this.tap = 1;
          this.doubleTap = 0;
          this.tripleTap = 0;
          break;
        case 2:
          this.tap = 0;
          this.doubleTap = 1;
          this.tripleTap = 0;
          break;
        case 3:
          this.tap = 0;
          this.doubleTap = 0;
          this.tripleTap = 1;
          break;
        case 0:
          this.tap = 0;
          this.doubleTap = 0;
          this.tripleTap = 0;
          break;
        default:
          break;
      }
      this.count = 0;
    }
  }

  getValues() {
    return {
      count: this.count,
      tap: this.tap,
      dtap: this.doubleTap,
      ttap: this.tripleTap,
      press: this.press,
      hold: this.hold,
      pressTime: this.pressTime,
    };
  }
}

// ## multi-axis wrappers

export class Shake3D {
  constructor(params) {
    this.axes = [new Shake(params), new Shake(params), new Shake(params)];
  }

  update([x, y, z], now) {
    return [
      this.axes[0].update(x, now),
      this.axes[1].update(y, now),
      this.axes[2].update(z, now),
    ];
  }
}

export class Jab3D {
  constructor(params) {
    this.axes = [new Jab(params), new Jab(params), new Jab(params)];
  }

  update([x, y, z]) {
    return [
      this.axes[0].update(x),
      this.axes[1].update(y),
      this.axes[2].update(z),
    ];
  }
}

// Brush/Rub on both screen axes. Positions are normalized 0-1, which keeps the
// |delta| > 1 teleport guard meaningful (a jump across the whole screen).
export class BrushRub2D {
  constructor(params) {
    this.brushX = new Brush(params);
    this.brushY = new Brush(params);
    this.rubX = new Rub(params);
    this.rubY = new Rub(params);
  }

  update([x, y], now) {
    return {
      brush: [this.brushX.update(x, now), this.brushY.update(y, now)],
      rub: [this.rubX.update(x, now), this.rubY.update(y, now)],
    };
  }
}

// Build every detector from the live `gestureParams` values so a dashboard edit
// rebuilds them with the new constants.
export function createDetectors(p) {
  return {
    shake: new Shake3D({
      threshold: p.shakeThreshold,
      fastLeak: p.shakeFastLeak,
      slowLeak: p.shakeSlowLeak,
      frequency: p.shakeFrequency,
    }),
    jab: new Jab3D({
      threshold: p.jabThreshold,
      window: p.jabWindow,
    }),
    touch: new BrushRub2D({
      leak: p.brushLeak,
      frequency: p.brushFrequency,
      scale: p.brushScale,
    }),
    button: new Button({
      countInterval: p.buttonCountInterval,
      holdInterval: p.buttonHoldInterval,
    }),
  };
}

export const GESTURE_PARAM_KEYS = [
  'shakeThreshold',
  'shakeEmitThreshold',
  'shakeFastLeak',
  'shakeSlowLeak',
  'shakeFrequency',
  'jabThreshold',
  'jabWindow',
  'brushLeak',
  'brushFrequency',
  'brushScale',
  'buttonCountInterval',
  'buttonHoldInterval',
];
