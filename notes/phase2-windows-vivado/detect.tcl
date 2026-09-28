open_hw_manager
connect_hw_server -url localhost:3121
puts "TARGETS: [get_hw_targets]"
open_hw_target
puts "DEVICES: [get_hw_devices]"
set dev [lindex [get_hw_devices xc7a100t*] 0]
refresh_hw_device $dev
puts "DONE_STATUS: [get_property REGISTER.CONFIG_STATUS.BIT14_DONE_PIN $dev]"
close_hw_target
disconnect_hw_server
close_hw_manager
