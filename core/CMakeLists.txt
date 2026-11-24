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
  src/kinematics.cpp
  src/tire.cpp
  src/drivetrain.cpp
  src/vehicle.cpp
  src/sim.cpp
  src/controls.cpp
  src/damage.cpp
  src/route.cpp
  src/ai.cpp
  src/racing_line.cpp
  src/incandescence.cpp
  src/dyno.cpp
  src/cluster.cpp
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

# OpenGrid real-time physical combustion engine audio library:
# Vendors AngeTheGreat's headless MIT engine-sim + simple-2d-constraint-solver + csv-io
# (core/third_party/engine_sim/) and adds our dual-mic exhaust/intake waveguide, Forza-grade
# exhaust stages, anti-lag detonations, turbo surge flutter, supercharger whine, and 4-rotor Wankel.
find_package(Threads REQUIRED)
file(GLOB ES_SOURCES CONFIGURE_DEPENDS
  third_party/engine_sim/src/*.cpp
  third_party/engine_sim/scs/src/*.cpp
  third_party/engine_sim/csv_io/src/*.cpp)
add_library(opengrid_engine_sim STATIC ${ES_SOURCES})
target_include_directories(opengrid_engine_sim PUBLIC
  third_party/engine_sim/include
  third_party/engine_sim/scs/include
  third_party/engine_sim/csv_io/include)
target_link_libraries(opengrid_engine_sim PUBLIC Threads::Threads)
set_target_properties(opengrid_engine_sim PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(opengrid_engine_sim PRIVATE -w)   # third-party MIT library
  target_compile_definitions(opengrid_engine_sim PUBLIC __forceinline=inline)
elseif(MSVC)
  target_compile_options(opengrid_engine_sim PRIVATE /W0 /EHsc /utf-8 /D_CRT_SECURE_NO_WARNINGS /DNOMINMAX)
endif()

add_library(opengrid_engine_audio STATIC src/engine_audio.cpp)
target_include_directories(opengrid_engine_audio PUBLIC include)
target_link_libraries(opengrid_engine_audio PRIVATE opengrid_engine_sim)
set_target_properties(opengrid_engine_audio PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU")
  target_compile_options(opengrid_engine_audio PRIVATE -Wall -Wextra -Wpedantic -Wno-changes-meaning)
elseif(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  target_compile_options(opengrid_engine_audio PRIVATE -Wall -Wextra -Wpedantic)
elseif(MSVC)
  target_compile_options(opengrid_engine_audio PRIVATE /W3 /EHsc /utf-8 /DNOMINMAX)
endif()

add_executable(opengrid_engine_dyno tools/opengrid_engine_dyno.cpp)
target_link_libraries(opengrid_engine_dyno PRIVATE opengrid_engine_audio)

add_executable(mf_dump tools/mf_dump.cpp)
target_include_directories(mf_dump PRIVATE third_party)
target_link_libraries(mf_dump PRIVATE rs_core)

# Per-tick CPU cost benchmark (not a test: timings depend on the machine).
add_executable(rs_bench bench/bench_race.cpp)
target_link_libraries(rs_bench PRIVATE rs_core)

add_executable(rs_bench_runtime bench/bench_runtime.cpp)
target_link_libraries(rs_bench_runtime PRIVATE rs_core)

option(RS_BUILD_TESTS "Build headless physics tests" ON)
if(RS_BUILD_TESTS)
  enable_testing()
  find_package(Threads REQUIRED)
  file(GLOB RS_TEST_SOURCES CONFIGURE_DEPENDS tests/*.cpp)
  add_executable(rs_tests ${RS_TEST_SOURCES})
  target_link_libraries(rs_tests PRIVATE rs_core opengrid_engine_audio Threads::Threads)
  target_include_directories(rs_tests PRIVATE third_party)
  target_compile_definitions(rs_tests PRIVATE RS_DATA_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../data")
  # One CTest entry per test case so failures are reported individually.
  foreach(t tire tire_symmetry tire_patch config kinematics static weight_transfer braking cornering acceleration timestep layouts auto_clutch abs tc esc controls auto_gearbox damage route ai_lap ai_traffic race race_uturn setup reference reference_fwd characters ue5_bridge telemetry cops authority ue5_upgrade gameplay pinnacle esports service ground_strip ground_strip_drive spsc_ring triple_buffer fixed_step runtime_determinism runtime_threaded ue5_async_bridge clutch_bite_point clutch_thermal_wear clutch_lockup_no_chatter gearbox_missed_shift gearbox_clutched_shift auto_clutch_quality anti_pitch brake_fade h_shifter self_aligning pedal_reverse wreck_drivable_fire_brakes tyre_thermal brake_cold_pads steering_feel diff_split_mu aero understeer_gradient trail_braking handbrake_slide snap_oversteer curb_strike wet_braking adac_braking racing_line incandescence burnout dyno cluster cluster_gauges engine_audio tire_library epa_coastdown iso4138_steady_circle iso7401_step_steer iso7975_braking_in_turn reference_data_fmvss_braking reference_data_top_speed_balance reference_data_measured_engine_curve reference_data_nhtsa_tilt_table reference_data_chrono_engine_maps reference_data_epa_final_drives reference_data_aero_forces)
    add_test(NAME ${t} COMMAND rs_tests ${t})
  endforeach()
endif()
