# Simulate

**Simulate** runs the testbench from `sim/` (the one marked `TESTBENCH`).

A good testbench checks itself with `assert … report … severity error;` and ends the simulation itself with `std.env.stop;` (VHDL-2008) after a final message such as `ALL TESTS PASSED`. The starter project's testbench does exactly that, and so do the testbenches created with **Add File**.

A failed assertion marks the simulation as failed and shows the message.

If a testbench has a free-running clock but never calls `std.env.stop`, the simulation never ends. Either add `std.env.stop;`, or give the project a fixed length: click **Simulation length** in the Project view (or run **NexysVHDL: Set Simulation Stop Time…**) and choose, for example, `1us`. Projects that do not set a stop time behave exactly as before.
