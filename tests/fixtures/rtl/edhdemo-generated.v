module blink_counter_Brtl_26
  (input  clk,
   input  reset,
   output q);
  reg [26:0] count;
  wire [26:0] n9;
  wire [26:0] n11;
  wire n14;
  reg [26:0] n15;
  assign q = n14; //(module output)
  /*# C:\proj\EdhDemo\src\blink_counter.vhd:15:12 */
  always @*
    count = n15; // (isignal)
  initial
    count = 27'b000000000000000000000000000;
  /*# C:\proj\EdhDemo\src\blink_counter.vhd:23:32 */
  assign n9 = count + 27'b000000000000000000000000001;
  /*# C:\proj\EdhDemo\src\blink_counter.vhd:20:13 */
  assign n11 = reset ? 27'b000000000000000000000000000 : n9;
  /*# C:\proj\EdhDemo\src\blink_counter.vhd:27:15 */
  assign n14 = count[26]; // extract
  /*# C:\proj\EdhDemo\src\blink_counter.vhd:19:9 */
  always @(posedge clk)
    n15 <= n11;
  initial
    n15 = 27'b000000000000000000000000000;
endmodule

module top
  (input  clk,
   input  btnc,
   input  sw0,
   output led0);
  wire blink;
  wire n2;
  assign led0 = n2; //(module output)
  /*# C:\proj\EdhDemo\src\top.vhd:28:5 */
  blink_counter_Brtl_26 u_blink (
    .clk(clk),
    .reset(btnc),
    .q(blink));
  /*# C:\proj\EdhDemo\src\top.vhd:32:19 */
  assign n2 = blink & sw0;
endmodule

