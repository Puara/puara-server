// Resolves the puara-gestures checkout the addon compiles against.
//
// This branch exists to test that library, so the source of truth is a working
// copy on disk, not a package version: point PUARA_GESTURES_PATH at any clone
// and rebuild to test that branch. The default is a sibling of this repo, which
// is how the two are normally cloned.
//
// Consumed from binding.gyp, which can only call out to `node -p`, so every
// value here is a plain string.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PATH = path.resolve(__dirname, '..', '..', 'puara-gestures');

const root = path.resolve(process.env.PUARA_GESTURES_PATH || DEFAULT_PATH);

// Files that must exist for the checkout to be usable. The 3rdparty ones live
// in a git submodule, and a clone without `--recursive` leaves them missing —
// which shows up as a wall of missing-header errors unless it is caught here.
const required = {
  'include/puara/gestures.h': 'the library headers',
  '3rdparty/IMU_Sensor_Fusion/imu_orientation.cpp': 'the 3rdparty submodule (git submodule update --init --recursive)',
  '3rdparty/eigen/Eigen': 'the Eigen submodule (git submodule update --init --recursive)',
};

function verify() {
  if (!fs.existsSync(root)) {
    throw new Error(
      `puara-gestures not found at ${root}\n`
      + 'Clone it beside this repo, or set PUARA_GESTURES_PATH to your checkout.');
  }
  for (const [relative, what] of Object.entries(required)) {
    if (!fs.existsSync(path.join(root, relative))) {
      throw new Error(`${root} is missing ${relative} — ${what}`);
    }
  }
}

verify();

module.exports = {
  root,
  include: path.join(root, 'include'),
  thirdparty: path.join(root, '3rdparty'),
  eigen: path.join(root, '3rdparty', 'eigen'),
  // The one translation unit the header-only library still needs compiled.
  imuSource: path.join(root, '3rdparty', 'IMU_Sensor_Fusion', 'imu_orientation.cpp'),
  // gyp refuses to build a source given as an absolute path outside the project
  // ("No rule to make target"), but takes a relative one that climbs out of it.
  imuSourceRelative: path.relative(
    __dirname, path.join(root, '3rdparty', 'IMU_Sensor_Fusion', 'imu_orientation.cpp')),
};
