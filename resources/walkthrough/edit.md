# Edit VHDL

- Use **Add File** at the top of the **Design** view to create a new source, simulation testbench or constraints file, or to copy one from your computer into the project. Sources go to `src/`, testbenches to `sim/` and constraints to `constraints/`. Design files and testbenches are `.vhd`; constraints are `.xdc`.
- **Design** has two modes: **Files** lists your files by role (the top entity is marked `TOP`), and **Hierarchy** shows which entity instantiates which and updates every time you save. Switch with the buttons in the view's title bar.
- Right-click an entity → **Set as Top Entity** to choose what gets built.
- **Open Design Schematic** draws the blocks and port-map connections of one level.
