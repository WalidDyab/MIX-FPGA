## Nexys A7-100T - Phase 1: SW0 -> LED0

## SW0
set_property -dict { PACKAGE_PIN J15   IOSTANDARD LVCMOS33 } [get_ports {sw}]

## LED0
set_property -dict { PACKAGE_PIN H17   IOSTANDARD LVCMOS33 } [get_ports {led}]
