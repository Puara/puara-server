{
  "targets": [
    {
      "target_name": "puara_gestures",
      "sources": [
        "src/puara_addon.cpp",
        "<!(node -p \"require('./gestures-path.cjs').imuSourceRelative\")"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!(node -p \"require('./gestures-path.cjs').include\")",
        "<!(node -p \"require('./gestures-path.cjs').thirdparty\")",
        "<!(node -p \"require('./gestures-path.cjs').eigen\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++20"],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
      }
    }
  ]
}
