# rs_core: engine-independent vehicle physics + game logic. C++17, no dependencies except the
# vendored single-header nlohmann/json (third_party/, MIT).
cmake_minimum_required(VERSION 3.16)
project(rs_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(rs_core STATIC
  src/config.cpp
  src/tire.cpp
  src/drivetrain.cpp
  src/vehicle.cpp
  src/sim.cpp
  src/controls.cpp
  src/damage.cpp
  src/route.cpp
  src/ai.cpp
  src/race.cpp
  src/setup.cpp
  src/telemetry.cpp
  src/cops.cpp
  src/authority.cpp
  src/gameplay.cpp
  src/pinnacle.cpp
  src/esports.cpp)
target_include_directories(rs_core PUBLIC include PRIVATE third_party)
set_target_properties(rs_core PROPERTIES POSITION_INDEPENDENT_CODE ON)   # needed to link into the GDExtension
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(rs_core PRIVATE -Wall -Wextra -Wpedantic -Wshadow)
endif()
if(MSVC)
  target_compile_options(rs_core PRIVATE /W3 /EHsc /utf-8)
endif()
if(WIN32)
  target_link_libraries(rs_core PUBLIC ws2_32)   # UDP telemetry sockets (src/telemetry.cpp)
endif()

# Per-tick CPU cost benchmark (not a test: timings depend on the machine).
add_executable(rs_bench bench/bench_race.cpp)
target_link_libraries(rs_bench PRIVATE rs_core)

option(RS_BUILD_TESTS "Build headless physics tests" ON)
if(RS_BUILD_TESTS)
  enable_testing()
  find_package(Threads REQUIRED)
  file(GLOB RS_TEST_SOURCES CONFIGURE_DEPENDS tests/*.cpp)
  add_executable(rs_tests ${RS_TEST_SOURCES})
  target_link_libraries(rs_tests PRIVATE rs_core Threads::Threads)
  target_compile_definitions(rs_tests PRIVATE RS_DATA_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../data")
  # One CTest entry per test case so failures are reported individually.
  foreach(t tire config static weight_transfer braking cornering acceleration timestep layouts auto_clutch abs tc esc controls auto_gearbox damage route ai_lap ai_traffic race race_uturn setup reference characters ue5_bridge telemetry cops authority ue5_upgrade gameplay pinnacle esports service ground_strip ground_strip_drive spsc_ring triple_buffer fixed_step runtime_determinism runtime_threaded ue5_async_bridge)
    add_test(NAME ${t} COMMAND rs_tests ${t})
  endforeach()
endif()
