# Connect and program

1. Connect the Nexys A7 with the USB cable to the **PROG/UART** port and switch the board **ON**.
2. **Detect Boards** (Hardware view) should show the board and its serial number.
3. **Program FPGA** loads the latest bitstream into the FPGA (it is lost when the board is switched off).

On **Windows**, programming needs the official *Digilent USB/JTAG support* (Show Environment tells you whether it is ready). On **macOS** nothing else is needed.

"No board detected" usually means the cable is in the wrong port, the board is off, or (on Windows) the Digilent support is not installed.
