// FloraScan - Wokwi custom chip: KY-037 sound sensor module
// Models the kit's red microphone board (pins D0 + G A0).
//
//   AO  the raw microphone signal: it sits around mid-scale and swings
//       further up and down the louder it gets, so the ESP32 measures
//       loudness as the peak-to-peak swing over a short window
//   DO  comparator output: pulses HIGH while the sound is louder than the
//       blue-knob threshold
//
// While the simulation runs, click the chip and move the sliders.

#include "wokwi-api.h"
#include <stdint.h>
#include <stdlib.h>

// Wokwi's virtual ADCs use a 5 V full-scale reference on every board
// (see docs.wokwi.com/chips-api/analog), so 5.0 V reads as 4095 on the ESP32.
#define FULL_SCALE_V 5.0f
#define BIAS_FRACTION 0.50f    // quiet signal sits at mid-scale (raw ~2048)
#define QUIET_P2P 0.0035f      // background hiss: ~14 raw peak-to-peak
#define LOUD_P2P 0.25f         // 100 % level: ~1024 raw peak-to-peak
#define UPDATE_EVERY_US 500    // new microphone sample every 0.5 ms (2 kHz)

typedef struct {
  pin_t pin_ao;
  pin_t pin_do;
  uint32_t attr_level;
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

static float peak_to_peak(float level_pct) {
  return QUIET_P2P + (LOUD_P2P - QUIET_P2P) * level_pct / 100.0f;
}

static void chip_update(void *user_data) {
  chip_state_t *chip = (chip_state_t *)user_data;
  float level = attr_read_float(chip->attr_level);         // 0..100 %
  float threshold = attr_read_float(chip->attr_threshold); // 0..100 %

  float swing = noise(chip) * peak_to_peak(level) / 2.0f;  // -amp .. +amp
  pin_dac_write(chip->pin_ao, (BIAS_FRACTION + swing) * FULL_SCALE_V);

  float trip = peak_to_peak(threshold) / 2.0f;
  pin_write(chip->pin_do, (swing > trip || swing < -trip) ? HIGH : LOW);
}

void chip_init(void) {
  chip_state_t *chip = malloc(sizeof(chip_state_t));
  chip->pin_ao = pin_init("AO", ANALOG);
  chip->pin_do = pin_init("DO", OUTPUT_LOW);
  chip->attr_level = attr_init_float("level", 5.0f);
  chip->attr_threshold = attr_init_float("threshold", 60.0f);
  chip->rng = 0x6C078965u;

  const timer_config_t timer_config = {
    .callback = chip_update,
    .user_data = chip,
  };
  timer_t timer = timer_init(&timer_config);
  timer_start(timer, UPDATE_EVERY_US, true);
  chip_update(chip);
}