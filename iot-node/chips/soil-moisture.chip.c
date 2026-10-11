// FloraScan - Wokwi custom chip: soil moisture sensor module
// Models the kit's resistive fork probe + LM393 comparator board
// (FC-28 / YL-69 / HW-080 style, pins AO DO GND VCC).
//
//   AO  analog output: high voltage = dry soil, low voltage = wet soil
//   DO  comparator output: LOW when the soil is wetter than the blue-knob
//       threshold, HIGH when it is drier (same as the real board)
//
// While the simulation runs, click the chip and move the sliders.

#include "wokwi-api.h"
#include <stdint.h>
#include <stdlib.h>

// Wokwi's virtual ADCs use a 5 V full-scale reference on every board
// (see docs.wokwi.com/chips-api/analog), so 5.0 V reads as 4095 on the
// ESP32. The fractions below give the ESP32 the same raw numbers as a real
// module powered from 3.3 V.
#define FULL_SCALE_V 5.0f
#define DRY_FRACTION 1.00f   // probe in dry air -> raw ~4095
#define WET_FRACTION 0.35f   // probe in water   -> raw ~1430
#define NOISE_FRACTION 0.004f // +/-0.4 % jitter, like a real probe
#define UPDATE_EVERY_US 20000 // refresh the outputs every 20 ms

typedef struct {
  pin_t pin_ao;
  pin_t pin_do;
  uint32_t attr_moisture;
  uint32_t attr_threshold;
  uint32_t rng;
} chip_state_t;

// Small xorshift random generator, returns -1.0 .. +1.0
static float noise(chip_state_t *chip) {
  uint32_t x = chip->rng;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  chip->rng = x;
  return ((float)(x & 0xFFFF) / 32767.5f) - 1.0f;
}

static float clamp01(float v) {
  if (v < 0.0f) return 0.0f;
  if (v > 1.0f) return 1.0f;
  return v;
}

static void chip_update(void *user_data) {
  chip_state_t *chip = (chip_state_t *)user_data;
  float moisture = attr_read_float(chip->attr_moisture);   // 0..100 %
  float threshold = attr_read_float(chip->attr_threshold); // 0..100 %

  float fraction = DRY_FRACTION - (DRY_FRACTION - WET_FRACTION) * moisture / 100.0f;
  fraction = clamp01(fraction + NOISE_FRACTION * noise(chip));
  pin_dac_write(chip->pin_ao, fraction * FULL_SCALE_V);

  pin_write(chip->pin_do, moisture > threshold ? LOW : HIGH);
}

void chip_init(void) {
  chip_state_t *chip = malloc(sizeof(chip_state_t));
  chip->pin_ao = pin_init("AO", ANALOG);
  chip->pin_do = pin_init("DO", OUTPUT_HIGH);
  chip->attr_moisture = attr_init_float("moisture", 55.0f);
  chip->attr_threshold = attr_init_float("threshold", 35.0f);
  chip->rng = 0x2545F491u;

  const timer_config_t timer_config = {
    .callback = chip_update,
    .user_data = chip,
  };
  timer_t timer = timer_init(&timer_config);
  timer_start(timer, UPDATE_EVERY_US, true);
  chip_update(chip);
}