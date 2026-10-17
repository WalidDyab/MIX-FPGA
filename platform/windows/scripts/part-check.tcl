load_package device
set l [get_part_list -family {MAX 10}]
puts "MIXFPGA_PARTS count=[llength $l] target=[expr {[lsearch -exact $l 10M50DAF484C7G] >= 0}]"
