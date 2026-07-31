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

// Reads a [x, y, z] array into out[3], leaving it untouched if absent.
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

double magnitude(const double* v)
{
  return std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

Napi::Array vector3(Napi::Env env, double x, double y, double z)
{
  Napi::Array array = Napi::Array::New(env, 3);
  array.Set(0u, Napi::Number::New(env, x));
  array.Set(1u, Napi::Number::New(env, y));
  array.Set(2u, Napi::Number::New(env, z));
  return array;
}

Napi::Array vector2(Napi::Env env, double x, double y)
{
  Napi::Array array = Napi::Array::New(env, 2);
  array.Set(0u, Napi::Number::New(env, x));
  array.Set(1u, Napi::Number::New(env, y));
  return array;
}

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
    // library's own, which assume an ESP32 instrument's ranges.
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
    impact_.threshold = numberAt(params, "impactThreshold", impact_.threshold);
    impact_.releaseThreshold
        = numberAt(params, "impactReleaseThreshold", impact_.releaseThreshold);
    impact_.minInterval = static_cast<unsigned long>(
        numberAt(params, "impactMinInterval", static_cast<double>(impact_.minInterval)));
    envelope_.attack = numberAt(params, "envelopeAttack", envelope_.attack);
    envelope_.release = numberAt(params, "envelopeRelease", envelope_.release);
    stillness_.threshold = numberAt(params, "stillnessThreshold", stillness_.threshold);
    stillness_.settleTime = static_cast<unsigned long>(
        numberAt(params, "stillnessSettleTime", static_cast<double>(stillness_.settleTime)));
    segmenter_.onThreshold = numberAt(params, "segmenterOnThreshold", segmenter_.onThreshold);
    segmenter_.offThreshold = numberAt(params, "segmenterOffThreshold", segmenter_.offThreshold);
    freefall_.threshold = numberAt(params, "freefallThreshold", freefall_.threshold);
    rhythm_.smoothing = numberAt(params, "rhythmSmoothing", rhythm_.smoothing);
    rhythm_.timeout = numberAt(params, "rhythmTimeout", rhythm_.timeout);
    ribbon_.tapMaxTime = numberAt(params, "ribbonTapMaxTime", ribbon_.tapMaxTime);
    ribbon_.tapMaxTravel = numberAt(params, "ribbonTapMaxTravel", ribbon_.tapMaxTravel);

    const double deadzone = numberAt(params, "spinDeadzone", spin_.x.deadzone);
    spin_.x.deadzone = deadzone;
    spin_.y.deadzone = deadzone;
    spin_.z.deadzone = deadzone;

    // shake/jab keep the names the dashboard already uses for the JS ports
    const double shakeThreshold = numberAt(params, "shakeThreshold", shake_.x.threshold);
    shake_.x.threshold = shakeThreshold;
    shake_.y.threshold = shakeThreshold;
    shake_.z.threshold = shakeThreshold;
    const double jabThreshold = numberAt(params, "jabThreshold", jab_.x.threshold);
    jab_.x.threshold = jabThreshold;
    jab_.y.threshold = jabThreshold;
    jab_.z.threshold = jabThreshold;
    button_.countInterval = static_cast<unsigned int>(
        numberAt(params, "buttonCountInterval", static_cast<double>(button_.countInterval)));
    button_.holdInterval = static_cast<unsigned int>(
        numberAt(params, "buttonHoldInterval", static_cast<double>(button_.holdInterval)));
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

    const double activity = magnitude(linear);
    const double total = magnitude(accel);

    // ## movement, from gravity-free acceleration
    shake_.update(puara_gestures::Coord3D{linear[0], linear[1], linear[2]});
    jab_.update(puara_gestures::Coord3D{linear[0], linear[1], linear[2]});
    envelope_.update(activity);
    impact_.update(activity);
    stillness_.update(activity);
    segmenter_.update(activity);
    derivative_.update(activity);

    // ## free-fall needs the total, including gravity: weightless is ~0
    freefall_.update(total);

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
        vectorAtIndex(touches, 0, primary);
      if(touchCount > 1)
        vectorAtIndex(touches, 1, secondary);
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

  static void vectorAtIndex(const Napi::Array& array, uint32_t index, double* out)
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

  // One flat object per tick. Keys are the OSC leaf names the bridge emits, so
  // the namespace and this function are read side by side.
  Napi::Object describe(Napi::Env env, int touchCount)
  {
    Napi::Object out = Napi::Object::New(env);

    auto shake = shake_.current_value();
    out.Set("shake", vector3(env, shake.x, shake.y, shake.z));
    auto jab = jab_.current_value();
    out.Set("jab", vector3(env, jab.x, jab.y, jab.z));

    out.Set("envelope", Napi::Number::New(env, envelope_.current_value()));

    Napi::Object impact = Napi::Object::New(env);
    impact.Set("strike", Napi::Boolean::New(env, impact_.strike));
    impact.Set("intensity", Napi::Number::New(env, impact_.intensity));
    impact.Set("count", Napi::Number::New(env, impact_.count));
    out.Set("impact", impact);

    Napi::Object stillness = Napi::Object::New(env);
    stillness.Set("still", Napi::Boolean::New(env, stillness_.still));
    stillness.Set("settled", Napi::Boolean::New(env, stillness_.settled));
    stillness.Set("stillTime", Napi::Number::New(env, stillness_.stillTime));
    out.Set("stillness", stillness);

    Napi::Object segmenter = Napi::Object::New(env);
    segmenter.Set("active", Napi::Boolean::New(env, segmenter_.active));
    segmenter.Set("onset", Napi::Boolean::New(env, segmenter_.onset));
    segmenter.Set("offset", Napi::Boolean::New(env, segmenter_.offset));
    segmenter.Set("duration", Napi::Number::New(env, segmenter_.duration));
    segmenter.Set("count", Napi::Number::New(env, segmenter_.count));
    out.Set("segmenter", segmenter);

    Napi::Object freefall = Napi::Object::New(env);
    freefall.Set("freefall", Napi::Boolean::New(env, freefall_.freefall));
    freefall.Set("onset", Napi::Boolean::New(env, freefall_.onset));
    freefall.Set("landed", Napi::Boolean::New(env, freefall_.landed));
    freefall.Set("fallTime", Napi::Number::New(env, freefall_.fallTime));
    out.Set("freefall", freefall);

    Napi::Object derivative = Napi::Object::New(env);
    derivative.Set("velocity", Napi::Number::New(env, derivative_.velocity));
    derivative.Set("acceleration", Napi::Number::New(env, derivative_.acceleration));
    derivative.Set("jerk", Napi::Number::New(env, derivative_.jerk));
    out.Set("derivative", derivative);

    Napi::Object spin = Napi::Object::New(env);
    spin.Set("velocity", vector3(env, spin_.x.velocity, spin_.y.velocity, spin_.z.velocity));
    spin.Set("angle", vector3(env, spin_.x.angle, spin_.y.angle, spin_.z.angle));
    spin.Set(
        "revolutions",
        vector3(env, spin_.x.revolutions, spin_.y.revolutions, spin_.z.revolutions));
    spin.Set(
        "turns",
        vector3(
            env, static_cast<double>(spin_.x.turns), static_cast<double>(spin_.y.turns),
            static_cast<double>(spin_.z.turns)));
    out.Set("spin", spin);

    Napi::Object orientation = Napi::Object::New(env);
    orientation.Set("tilt", Napi::Number::New(env, tiltRoll_.current_tilt_value()));
    orientation.Set("roll", Napi::Number::New(env, tiltRoll_.current_roll_value()));
    out.Set("orientation", orientation);

    Napi::Object rhythm = Napi::Object::New(env);
    rhythm.Set("onset", Napi::Boolean::New(env, rhythm_.onset));
    rhythm.Set("onsetCount", Napi::Number::New(env, rhythm_.onsetCount));
    rhythm.Set("interval", Napi::Number::New(env, rhythm_.interval));
    rhythm.Set("frequency", Napi::Number::New(env, rhythm_.frequency));
    rhythm.Set("period", Napi::Number::New(env, rhythm_.period));
    rhythm.Set("tempo", Napi::Number::New(env, rhythm_.tempo));
    out.Set("rhythm", rhythm);

    Napi::Object ribbon = Napi::Object::New(env);
    ribbon.Set("position", Napi::Number::New(env, ribbon_.position));
    ribbon.Set("velocity", Napi::Number::New(env, ribbon_.velocity));
    ribbon.Set("direction", Napi::Number::New(env, ribbon_.direction));
    ribbon.Set("touched", Napi::Boolean::New(env, ribbon_.touched));
    ribbon.Set("tap", Napi::Boolean::New(env, ribbon_.tap));
    out.Set("ribbon", ribbon);

    Napi::Object multitouch = Napi::Object::New(env);
    multitouch.Set("distance", Napi::Number::New(env, multitouch_.distance));
    multitouch.Set("scale", Napi::Number::New(env, multitouch_.scale));
    multitouch.Set("spread", Napi::Number::New(env, multitouch_.spread));
    multitouch.Set("rotation", Napi::Number::New(env, multitouch_.rotation));
    multitouch.Set("angle", Napi::Number::New(env, multitouch_.angle));
    multitouch.Set("engaged", Napi::Boolean::New(env, touchCount > 1));
    out.Set("multitouch", multitouch);

    Napi::Object button = Napi::Object::New(env);
    button.Set("count", Napi::Number::New(env, button_.count));
    button.Set("press", Napi::Boolean::New(env, button_.press));
    button.Set("tap", Napi::Number::New(env, button_.tap));
    button.Set("doubleTap", Napi::Number::New(env, button_.doubleTap));
    button.Set("tripleTap", Napi::Number::New(env, button_.tripleTap));
    button.Set("hold", Napi::Boolean::New(env, button_.hold));
    button.Set("pressTime", Napi::Number::New(env, button_.pressTime));
    out.Set("button", button);

    out.Set(
        "brush", vector2(env, brushRubX_.brush.value, brushRubY_.brush.value));
    out.Set("rub", vector2(env, brushRubX_.rub.value, brushRubY_.rub.value));

    return out;
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
