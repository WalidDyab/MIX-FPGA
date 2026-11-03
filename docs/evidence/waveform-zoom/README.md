# Waveform zoom-out fix: engineering evidence

Project: `D:\Vivado_Projects\Term261\TWO_PERIOD_COUNTER_PROJECT` (used unchanged; its sources were copied to a scratch folder to re-run the simulation).
Simulation: bundled GHDL, the project's own command line (`ghdl -r --std=08 Test_01 --assert-level=error --stop-time=1000us --vcd=waveform.vcd`).
The re-run VCD is identical to the project's `.nexysvhdl/sim/waveform.vcd` except for the `$date` line.

## VCD (timescale 1 fs, run ends at 1000 us)

- `period_1_out`: 0 at 0; then 1 at `50.095 us + k*60 us`, 0 at `50.105 us + k*60 us`, k = 0..15 (16 pulses, each 10 ns = one 100 MHz cycle).
- `period_2_out`: 0 at 0; then 1 at `60.095 us + k*60 us`, 0 at `60.105 us + k*60 us`, k = 0..15.

## Screenshots (viewer page with the real data, 1300 px wide; scale: 1000 us over about 690 px)

| File | Renderer | View |
| --- | --- | --- |
| `1-zoomed-out-before.png` | before the fix | full run: both outputs shaded "high" from the first pulse to the end |
| `2-zoomed-out-after.png` | after | full run: 16 narrow marks each, low between them |
| `3-zoomed-in-pulse-after.png` | after | 30 ns around the first pulse: rise 50.095 us, fall 50.105 us |
| `4-zoomed-in-pulse-before.png` | before | same view: identical to 3 (exact rendering is unchanged) |
| `5-mid-zoom-16us-after.png` | after | about 16 us: the 60.095 us pulse of `period_2_out` is a mark returning low |

## Cursor (read from the viewer's value column, which uses the raw trace)

At full view and after 6, 12 and 15 zoom-ins, for `period_1_out` / `period_2_out`:
50.090 us 0/0, 50.100 us 1/0, 50.105 us 0/0, 50.110 us 0/0, 60.100 us 0/1, 30 us 0/0. The values were the same at every zoom level.
