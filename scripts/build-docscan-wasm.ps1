param(
    [string]$LibraryRoot = (Join-Path $PSScriptRoot '../../thuvien'),
    [string]$SdkRoot = (Join-Path $PSScriptRoot '../.tmp-wasm/emsdk'),
    [string]$Cmake = 'C:/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe',
    [string]$Ninja = 'C:/Program Files/Microsoft Visual Studio/2022/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe'
)
$ErrorActionPreference = 'Stop'
$webRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LibraryRoot = (Resolve-Path $LibraryRoot).Path
$SdkRoot = (Resolve-Path $SdkRoot).Path
$sdkVersion = (Get-Content -Raw (Join-Path $SdkRoot 'upstream/emscripten/emscripten-version.txt')).Trim().Trim('"')
if ($sdkVersion -ne '6.0.13') { throw 'This target is verified with Emscripten 6.0.13. Use the pinned SDK or revalidate before updating its version.' }
$env:EM_CONFIG = Join-Path $SdkRoot '.emscripten'
$env:PATH = "$(Split-Path $Cmake);$(Split-Path $Ninja);$SdkRoot/upstream/emscripten;$env:PATH"
$buildRoot = Join-Path $webRoot '.tmp-wasm'
$cvSource = Join-Path $LibraryRoot '.deps/opencv-ea8e60798e0319ccbe902f7994153b574f639809'
$toolchain = Join-Path $SdkRoot 'upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake'
function Run-Cmake([string[]]$Arguments) {
    & $Cmake @Arguments
    if ($LASTEXITCODE -ne 0) { throw "CMake failed: $LASTEXITCODE" }
}
Run-Cmake @('-S', $cvSource, '-B', "$buildRoot/opencv", '-G', 'Ninja', "-DCMAKE_MAKE_PROGRAM=$Ninja", "-DCMAKE_TOOLCHAIN_FILE=$toolchain", '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_LIST=core,imgproc', '-DBUILD_SHARED_LIBS=OFF', '-DBUILD_TESTS=OFF', '-DBUILD_PERF_TESTS=OFF', '-DBUILD_EXAMPLES=OFF', '-DBUILD_opencv_apps=OFF', '-DBUILD_DOCS=OFF', '-DWITH_IPP=OFF', '-DWITH_OPENCL=OFF', '-DWITH_ITT=OFF', '-DWITH_PTHREADS_PF=OFF', '-DWITH_PROTOBUF=OFF', '-DCPU_BASELINE=', '-DCPU_DISPATCH=', '-DCV_ENABLE_INTRINSICS=OFF', '-DCMAKE_CXX_FLAGS=-fexceptions', '-DCMAKE_C_FLAGS=-fexceptions')
Run-Cmake @('--build', "$buildRoot/opencv", '--parallel', '4')
Run-Cmake @('-S', "$LibraryRoot/wasm", '-B', "$buildRoot/docscan", '-G', 'Ninja', "-DCMAKE_MAKE_PROGRAM=$Ninja", "-DCMAKE_TOOLCHAIN_FILE=$toolchain", "-DOpenCV_DIR=$buildRoot/opencv", '-DCMAKE_BUILD_TYPE=Release')
Run-Cmake @('--build', "$buildRoot/docscan", '--parallel', '4')
$destination = Join-Path $webRoot 'public/docscan-wasm/v1'
New-Item -ItemType Directory -Force $destination | Out-Null
Copy-Item -LiteralPath "$buildRoot/docscan/docscan.mjs", "$buildRoot/docscan/docscan.wasm" -Destination $destination
$sources = @('src/pixels.hpp', 'src/geometry.cpp', 'src/quality.cpp', 'src/filters.cpp', 'src/lab.hpp', 'wasm/bridge.cpp', 'wasm/CMakeLists.txt')
$hashes = @{}
foreach ($name in $sources) { $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $LibraryRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() }
$manifest = @{ schema = 1; emscripten = '6.0.13'; opencv = 'ea8e60798e0319ccbe902f7994153b574f639809'; sources = $hashes; wasm_sha256 = (Get-FileHash "$destination/docscan.wasm" -Algorithm SHA256).Hash.ToLowerInvariant(); boundary = 'shared browser decode -> native warp/measure/enhance -> shared browser encode/PDF'; maximum_input_pixels = 50000000; maximum_output_side = 3000; maximum_wasm_bytes = 805306368 }
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 "$destination/build.json"
Copy-Item -LiteralPath (Join-Path $cvSource 'LICENSE') -Destination "$destination/OpenCV-LICENSE.txt"
Copy-Item -LiteralPath (Join-Path $SdkRoot 'upstream/emscripten/LICENSE') -Destination "$destination/Emscripten-LICENSE.txt"
$licenseText = (Get-Content -Raw "$destination/Emscripten-LICENSE.txt") -replace '(?m)[ \t]+$', ''
[System.IO.File]::WriteAllText("$destination/Emscripten-LICENSE.txt", $licenseText.TrimEnd() + "`n")
foreach ($runtime in @('libcxx', 'libcxxabi', 'compiler-rt')) {
    Copy-Item -LiteralPath (Join-Path $SdkRoot "upstream/emscripten/system/lib/$runtime/LICENSE.TXT") -Destination "$destination/$runtime-LICENSE.txt"
}
Write-Output "WASM assets ready: $destination"
