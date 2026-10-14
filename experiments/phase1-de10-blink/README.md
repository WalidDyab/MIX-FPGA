# phase1-de10-blink

VHDL: `src/blink.vhd` (top `blink`). Constraints: `constraints/de10-lite.{qsf,sdc}`.
Device `10M50DAF484C7G`; `clk_50` = PIN_P11, `ledr0` = PIN_A8 (Terasic DE10-Lite User Manual v1.7, Tables 3-2/3-5).
Build via `platform/macos/de10/mixfpga-build.sh experiments/phase1-de10-blink`; output under `.mix-fpga/build/de10-lite/`.
