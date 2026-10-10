// N-API binding around puara-gestures, so puara-server can drive the real C++
// descriptors instead of the JS ports in src/shared/gestures.js.
//
// One `Bank` per connected phone. The bridge hands it a frame of raw sensor and
// touch data at its tick and gets back every descriptor's outputs, which it then
// emits over OSC and publishes for the dashboard. The descriptors time
// themselves from the C++ monotonic clock, so a Bank must be fed in real time —
// this is a live test bench, not an offline batch runner.
//
// What is wired and what is not is decided by what a phone browser can actually
// measure: no magnetometer (rules out Heading, Tilt and Roll, which need one)
// and no pressure sensor (rules out Breath).

#include <napi.h>
#include <puara/gestures.h>

#include <cmath>

namespace {

// Matches GRAVITY_ALPHA in src/clients/player.js: browsers expose
// `acceleration` (gravity-free) unreliably, so the gravity vector is low-passed
// out of `accelerationIncludingGravity` instead. Done here rather than on the
// phone so the addon takes exactly what the browser reported.
constexpr double kGravityAlpha = 0.03;

double numberAt(const Napi::Object& object, const char* key, double fallback)
{
  Napi::Value value = object.Get(key);
  return value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : fallback;
}

// Overwrites `target` only when the key holds a number, so a partial params
// object leaves the rest of the tuning alone.
template <typename T>
void readInto(const Napi::Object& object, const char* key, T& target)
{
  target = static_cast<T>(numberAt(object, key, static_cast<double>(target)));
}

// Reads a [x, y, z] array into out[length], leaving it untouched if absent.
void vectorAt(const Napi::Object& object, const char* key, double* out, int length)
{
  Napi::Value value = object.Get(key);
  if(!value.IsArray())
    return;
  Napi::Array array = value.As<Napi::Array>();
  for(int i = 0; i < length && i < static_cast<int>(array.Length()); i++)
  {
    Napi::Value entry = array.Get(i);
    if(entry.IsNumber())
      out[i] = entry.As<Napi::Number>().DoubleValue();
  }
}

void pairAt(const Napi::Array& array, uint32_t index, double* out)
{
  Napi::Value entry = array.Get(index);
  if(!entry.IsArray())
    return;
  Napi::Array pair = entry.As<Napi::Array>();
  for(uint32_t i = 0; i < 2 && i < pair.Length(); i++)
  {
    Napi::Value value = pair.Get(i);
    if(value.IsNumber())
      out[i] = value.As<Napi::Number>().DoubleValue();
  }
}

double magnitude(const double* v)
{
  return std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

// A JS object under construction. Chainable so a descriptor's outputs read as
// its list of names and values, not as a wall of Napi::…::New.
class Fields
{
public:
  explicit Fields(Napi::Env env)
      : env_(env)
      , object_(Napi::Object::New(env))
  {
  }

  Fields& num(const char* key, double value)
  {
    object_.Set(key, Napi::Number::New(env_, value));
    return *this;
  }

  Fields& flag(const char* key, bool value)
  {
    object_.Set(key, Napi::Boolean::New(env_, value));
    return *this;
  }

  Fields& vec(const char* key, double x, double y)
  {
    Napi::Array array = Napi::Array::New(env_, 2);
    array.Set(0u, Napi::Number::New(env_, x));
    array.Set(1u, Napi::Number::New(env_, y));
    object_.Set(key, array);
    return *this;
  }

  Fields& vec(const char* key, double x, double y, double z)
  {
    Napi::Array array = Napi::Array::New(env_, 3);
    array.Set(0u, Napi::Number::New(env_, x));
    array.Set(1u, Napi::Number::New(env_, y));
    array.Set(2u, Napi::Number::New(env_, z));
    object_.Set(key, array);
    return *this;
  }

  Fields& group(const char* key, const Fields& child)
  {
    object_.Set(key, child.object_);
    return *this;
  }

  Napi::Object object() const { return object_; }

private:
  Napi::Env env_;
  Napi::Object object_;
};

class Bank : public Napi::ObjectWrap<Bank>
{
public:
  static Napi::Function Init(Napi::Env env)
  {
    return DefineClass(
        env, "Bank",
        {
            InstanceMethod<&Bank::Update>("update"),
            InstanceMethod<&Bank::SetParams>("setParams"),
            InstanceMethod<&Bank::Anchor>("anchor"),
        });
  }

  explicit Bank(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<Bank>(info)
  {
    // Defaults tuned for a phone reporting m/s^2 and deg/s, rather than the
    // library's own, which assume an ESP32 instrument's ranges. Mirrored by
    // NATIVE_PARAMS in src/shared/native-gestures.js.
    impact_.threshold = 18.0;
    impact_.releaseThreshold = 12.0;
    impact_.minInterval = 120;
    envelope_.attack = 0.5;
    envelope_.release = 0.05;
    stillness_.threshold = 0.4;
    stillness_.settleTime = 700;
    segmenter_.onThreshold = 1.2;
    segmenter_.offThreshold = 0.6;
    segmenter_.minActiveSamples = 3;
    segmenter_.minSilentSamples = 5;
    freefall_.threshold = 3.0;
    spin_.x.deadzone = 5.0;
    spin_.y.deadzone = 5.0;
    spin_.z.deadzone = 5.0;
    rhythm_.threshold = 1;
    ribbon_.tapMaxTime = 250.0;

    if(info.Length() > 0 && info[0].IsObject())
      applyParams(info[0].As<Napi::Object>());
  }

private:
  // Every settable constant, so the dashboard can retune a descriptor live the
  // way it already retunes the JS ports. Names match the C++ members.
  void applyParams(const Napi::Object& params)
  {
    readInto(params, "impactThreshold", impact_.threshold);
    readInto(params, "impactReleaseThreshold", impact_.releaseThreshold);
    readInto(params, "impactMinInterval", impact_.minInterval);
    readInto(params, "envelopeAttack", envelope_.attack);
    readInto(params, "envelopeRelease", envelope_.release);
    readInto(params, "stillnessThreshold", stillness_.threshold);
    readInto(params, "stillnessSettleTime", stillness_.settleTime);
    readInto(params, "segmenterOnThreshold", segmenter_.onThreshold);
    readInto(params, "segmenterOffThreshold", segmenter_.offThreshold);
    readInto(params, "freefallThreshold", freefall_.threshold);
    readInto(params, "rhythmSmoothing", rhythm_.smoothing);
    readInto(params, "rhythmTimeout", rhythm_.timeout);
    readInto(params, "ribbonTapMaxTime", ribbon_.tapMaxTime);
    readInto(params, "ribbonTapMaxTravel", ribbon_.tapMaxTravel);

    // One control per 3-axis descriptor: the phone has no reason to tune an axis
    // on its own, and the dashboard would need three widgets to say so.
    const double deadzone = numberAt(params, "spinDeadzone", spin_.x.deadzone);
    spin_.x.deadzone = spin_.y.deadzone = spin_.z.deadzone = deadzone;

    // shake/jab/button keep the names the dashboard already uses for the JS ports
    const double shakeThreshold = numberAt(params, "shakeThreshold", shake_.x.threshold);
    shake_.x.threshold = shake_.y.threshold = shake_.z.threshold = shakeThreshold;
    const double jabThreshold = numberAt(params, "jabThreshold", jab_.x.threshold);
    jab_.x.threshold = jab_.y.threshold = jab_.z.threshold = jabThreshold;

    readInto(params, "buttonCountInterval", button_.countInterval);
    readInto(params, "buttonHoldInterval", button_.holdInterval);
  }

  Napi::Value SetParams(const Napi::CallbackInfo& info)
  {
    if(info.Length() > 0 && info[0].IsObject())
      applyParams(info[0].As<Napi::Object>());
    return info.Env().Undefined();
  }

  // MultiTouch measures pinch/twist against a reference pair, which has to be
  // re-taken when a new two-finger gesture starts.
  Napi::Value Anchor(const Napi::CallbackInfo& info)
  {
    multitouch_.anchor();
    return info.Env().Undefined();
  }

  Napi::Value Update(const Napi::CallbackInfo& info)
  {
    Napi::Env env = info.Env();
    if(info.Length() < 1 || !info[0].IsObject())
      throw Napi::TypeError::New(env, "update(frame) expects an object");

    Napi::Object frame = info[0].As<Napi::Object>();

    double accel[3] = {0, 0, 0};
    double gyro[3] = {0, 0, 0};
    vectorAt(frame, "accel", accel, 3);
    vectorAt(frame, "gyro", gyro, 3);

    // gravity estimate, and the gravity-free acceleration the movement
    // descriptors actually want
    double linear[3] = {0, 0, 0};
    for(int i = 0; i < 3; i++)
    {
      if(!gravitySeeded_)
        gravity_[i] = accel[i];
      else
        gravity_[i] += (accel[i] - gravity_[i]) * kGravityAlpha;
      linear[i] = accel[i] - gravity_[i];
    }
    gravitySeeded_ = true;

    const puara_gestures::Coord3D movement{linear[0], linear[1], linear[2]};
    const double activity = magnitude(linear);

    // ## movement, from gravity-free acceleration
    shake_.update(movement);
    jab_.update(movement);
    envelope_.update(activity);
    impact_.update(activity);
    stillness_.update(activity);
    segmenter_.update(activity);
    derivative_.update(activity);

    // ## free-fall needs the total, including gravity: weightless is ~0
    freefall_.update(magnitude(accel));

    // ## rotation, straight from the gyroscope
    spin_.update(puara_gestures::Coord3D{gyro[0], gyro[1], gyro[2]});

    // ## orientation from acceleration alone (no magnetometer in a browser)
    tiltRoll_.update(puara_gestures::Coord3D{accel[0], accel[1], accel[2]});

    // ## touch
    Napi::Value touchesValue = frame.Get("touches");
    int touchCount = 0;
    double primary[2] = {0, 0};
    double secondary[2] = {0, 0};
    if(touchesValue.IsArray())
    {
      Napi::Array touches = touchesValue.As<Napi::Array>();
      touchCount = static_cast<int>(touches.Length());
      if(touchCount > 0)
        pairAt(touches, 0, primary);
      if(touchCount > 1)
        pairAt(touches, 1, secondary);
    }

    const bool touched = touchCount > 0;
    // The touch surface as a button, which is also what drives the rhythm
    // descriptor: a phone has no discrete key to tap.
    button_.update(touched ? 1 : 0);
    rhythm_.update(button_.tap > 0 ? 1 : 0);
    ribbon_.update(primary[0], touched);
    brushRubX_.update(primary[0]);
    brushRubY_.update(primary[1]);

    if(touchCount > 1)
    {
      if(!pairHeld_)
      {
        // reset() rather than anchor(): anchoring here would capture the
        // reference geometry *before* the first update of this pair has computed
        // one, pinning `scale` to a zero reference for the whole gesture.
        // update() takes the reference itself on the first frame after a reset.
        multitouch_.reset();
        pairHeld_ = true;
      }
      multitouch_.update(
          puara_gestures::Coord2D{primary[0], primary[1]},
          puara_gestures::Coord2D{secondary[0], secondary[1]});
    }
    else
    {
      pairHeld_ = false;
    }

    return describe(env, touchCount);
  }

  // One object per tick. Keys are the OSC leaf names the bridge emits, so the
  // namespace and this function are read side by side.
  Napi::Object describe(Napi::Env env, int touchCount)
  {
    const auto shake = shake_.current_value();
    const auto jab = jab_.current_value();

    Fields out(env);
    out.vec("shake", shake.x, shake.y, shake.z)
        .vec("jab", jab.x, jab.y, jab.z)
        .num("envelope", envelope_.current_value())
        .group(
            "impact", Fields(env)
                          .flag("strike", impact_.strike)
                          .num("intensity", impact_.intensity)
                          .num("count", impact_.count))
        .group(
            "stillness", Fields(env)
                             .flag("still", stillness_.still)
                             .flag("settled", stillness_.settled)
                             .num("stillTime", stillness_.stillTime))
        .group(
            "segmenter", Fields(env)
                             .flag("active", segmenter_.active)
                             .flag("onset", segmenter_.onset)
                             .flag("offset", segmenter_.offset)
                             .num("duration", segmenter_.duration)
                             .num("count", segmenter_.count))
        .group(
            "freefall", Fields(env)
                            .flag("freefall", freefall_.freefall)
                            .flag("onset", freefall_.onset)
                            .flag("landed", freefall_.landed)
                            .num("fallTime", freefall_.fallTime))
        .group(
            "derivative", Fields(env)
                              .num("velocity", derivative_.velocity)
                              .num("acceleration", derivative_.acceleration)
                              .num("jerk", derivative_.jerk))
        .group(
            "spin",
            Fields(env)
                .vec("velocity", spin_.x.velocity, spin_.y.velocity, spin_.z.velocity)
                .vec("angle", spin_.x.angle, spin_.y.angle, spin_.z.angle)
                .vec(
                    "revolutions", spin_.x.revolutions, spin_.y.revolutions,
                    spin_.z.revolutions)
                .vec(
                    "turns", static_cast<double>(spin_.x.turns),
                    static_cast<double>(spin_.y.turns), static_cast<double>(spin_.z.turns)))
        .group(
            "orientation", Fields(env)
                               .num("tilt", tiltRoll_.current_tilt_value())
                               .num("roll", tiltRoll_.current_roll_value()))
        .group(
            "rhythm", Fields(env)
                          .flag("onset", rhythm_.onset)
                          .num("onsetCount", rhythm_.onsetCount)
                          .num("interval", rhythm_.interval)
                          .num("frequency", rhythm_.frequency)
                          .num("period", rhythm_.period)
                          .num("tempo", rhythm_.tempo))
        .group(
            "ribbon", Fields(env)
                          .num("position", ribbon_.position)
                          .num("velocity", ribbon_.velocity)
                          .num("direction", ribbon_.direction)
                          .flag("touched", ribbon_.touched)
                          .flag("tap", ribbon_.tap))
        .group(
            "multitouch", Fields(env)
                              .num("distance", multitouch_.distance)
                              .num("scale", multitouch_.scale)
                              .num("spread", multitouch_.spread)
                              .num("rotation", multitouch_.rotation)
                              .num("angle", multitouch_.angle)
                              .flag("engaged", touchCount > 1))
        .group(
            "button", Fields(env)
                          .num("count", button_.count)
                          .flag("press", button_.press)
                          .num("tap", button_.tap)
                          .num("doubleTap", button_.doubleTap)
                          .num("tripleTap", button_.tripleTap)
                          .flag("hold", button_.hold)
                          .num("pressTime", button_.pressTime))
        .vec("brush", brushRubX_.brush.value, brushRubY_.brush.value)
        .vec("rub", brushRubX_.rub.value, brushRubY_.rub.value);

    return out.object();
  }

  puara_gestures::Shake3D shake_;
  puara_gestures::Jab3D jab_;
  puara_gestures::Spin3D spin_;
  puara_gestures::Envelope envelope_;
  puara_gestures::Impact impact_;
  puara_gestures::Stillness stillness_;
  puara_gestures::Segmenter segmenter_;
  puara_gestures::Freefall freefall_;
  puara_gestures::Derivative derivative_;
  puara_gestures::Rhythm rhythm_;
  puara_gestures::MultiTouch multitouch_;
  puara_gestures::Ribbon ribbon_;
  puara_gestures::Tilt_Roll tiltRoll_;
  puara_gestures::Button button_;
  puara_gestures::BrushRubDetector brushRubX_;
  puara_gestures::BrushRubDetector brushRubY_;

  double gravity_[3] = {0, 0, 0};
  bool gravitySeeded_ = false;
  bool pairHeld_ = false;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports)
{
  exports.Set("Bank", Bank::Init(env));
  return exports;
}

} // namespace

NODE_API_MODULE(puara_gestures, InitAll)
