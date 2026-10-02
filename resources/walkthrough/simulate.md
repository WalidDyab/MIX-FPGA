# Simulate

**Simulate** runs the testbench from `sim/` (the one marked `TESTBENCH`).

A good testbench checks itself with `assert … report … severity error;` and finishes with a final message such as `ALL TESTS PASSED`. The starter project's testbench does exactly that.

A failed assertion marks the simulation as failed and shows the message.
