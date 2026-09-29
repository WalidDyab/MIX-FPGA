# Windows adapter fixtures

Used by `tests/platform/windows/*.test.ts`. Nothing here needs Windows, djtgcfg or a board.

`djtgcfg/` holds `djtgcfg` 2.6.1 (Adept Utilities 2.7.1) output.

- Files without `.synthetic` are real output, recorded on the Phase 1B/2/3B Windows machine (`notes/phase2-windows-djtgcfg.log`, `experiments/phase1b-windows-programmer/logs/`, Phase 3B captures).
- `*.synthetic.txt` files follow the same format for cases that could not be recorded with one board: several boards, other Digilent products, another FPGA on the chain, and unrecognised output.

Bitstreams are not stored (`*.bit` is ignored). The tests build synthetic `.bit` files in the Xilinx container format (`tests/platform/windows/windows-bit-builder.ts`).
