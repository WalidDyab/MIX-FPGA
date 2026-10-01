import type { DesignIndex } from '../hierarchy/design-index';
import { findNode, type HierarchyNode, isPlausibleInstance, type NodeLocation, type NodeStatus, resolveInstance } from '../hierarchy/hierarchy';
import type { InterfaceItem, PortMode } from '../hierarchy/vhdl-parser';

/**
 * Component-level Design Schematic model for one level of the hierarchy:
 * an entity, the blocks its architecture instantiates, and the port-map
 * connections between them. Built only from the structural index, so it
 * shows exactly what the port maps say. Connections made by assignments
 * or logic inside the architecture are not drawn (they are not wires
 * between blocks); see `notes`.
 */

export type SchematicMode = PortMode | 'unknown';

export interface SchematicPort {
    readonly name: string;
    readonly mode: SchematicMode;
    readonly type?: string;
}

export interface SchematicBlock {
    /** Instance label (unique within the level). */
    readonly id: string;
    readonly label: string;
    readonly entityName: string;
    readonly status: NodeStatus;
    readonly note?: string;
    readonly ports: readonly SchematicPort[];
    /** The instantiation statement. */
    readonly location?: NodeLocation;
    /** The instantiated entity's declaration, when resolved. */
    readonly entityLocation?: NodeLocation;
    /** Hierarchy node id, for drilling down. */
    readonly hierarchyId: string;
    readonly childCount: number;
    /** Enclosing generate labels: the block is replicated by a generate statement. */
    readonly generate: readonly string[];
}

/** One end of a connection: a port of the level's entity (`block` absent) or a pin of a block. */
export interface Endpoint {
    readonly block?: string;
    readonly port: string;
    readonly mode: SchematicMode;
    /** Actual as written when it is more than the plain name, e.g. `count(26)`. */
    readonly detail?: string;
}

export interface SchematicNet {
    /** Signal or port name as declared. */
    readonly name: string;
    /** `port` = a port of the level's entity; `signal` = a signal declared in its architecture. */
    readonly kind: 'port' | 'signal';
    readonly endpoints: readonly Endpoint[];
}

/** A block pin whose actual is not a plain signal/port (a literal, an expression, `open`). */
export interface SchematicStub {
    readonly block: string;
    readonly port: string;
    readonly mode: SchematicMode;
    readonly text: string;
}

export interface SchematicModel {
    readonly entityName: string;
    readonly hierarchyId: string;
    /** Breadcrumb from the root: hierarchy ids and display labels. */
    readonly path: readonly { readonly id: string; readonly label: string }[];
    readonly entityLocation?: NodeLocation;
    readonly architectureName?: string;
    readonly ports: readonly SchematicPort[];
    readonly blocks: readonly SchematicBlock[];
    readonly nets: readonly SchematicNet[];
    readonly stubs: readonly SchematicStub[];
    readonly notes: readonly string[];
}

const toPort = (p: InterfaceItem): SchematicPort => ({ name: p.name, mode: p.mode, type: p.type });
const lower = (s: string) => s.toLowerCase();

function breadcrumb(root: HierarchyNode, id: string): { id: string; label: string }[] {
    const parts = id.split('/');
    const out: { id: string; label: string }[] = [];
    for (let i = 1; i <= parts.length; i++) {
        const nodeId = parts.slice(0, i).join('/');
        const node = findNode(root, nodeId);
        if (!node) break;
        out.push({ id: nodeId, label: node.kind === 'instance' ? `${node.label} : ${node.entityName}` : node.entityName });
    }
    return out;
}

/** Builds the schematic for the hierarchy node `id` (default: the root). */
export function buildSchematic(index: DesignIndex, root: HierarchyNode, id: string = root.id): SchematicModel | undefined {
    const node = findNode(root, id);
    if (!node || !node.entity) return undefined;
    const entity = node.entity.decl;
    const ports = entity.ports.map(toPort);
    const arch = node.architecture;
    const notes: string[] = [];
    const base = {
        entityName: entity.name,
        hierarchyId: node.id,
        path: breadcrumb(root, node.id),
        entityLocation: { file: node.entity.file, line: entity.line, col: entity.col },
        ports,
    };
    if (!arch) {
        return { ...base, blocks: [], nets: [], stubs: [], notes: [node.note ?? 'No architecture was found for this entity.'] };
    }

    const portNames = new Map(ports.map((p) => [lower(p.name), p]));
    const signals = new Map(arch.decl.signals.map((s) => [lower(s.name), s]));
    const blocks: SchematicBlock[] = [];
    const nets = new Map<string, { name: string; kind: 'port' | 'signal'; endpoints: Endpoint[] }>();
    const stubs: SchematicStub[] = [];

    for (const inst of arch.decl.instances) {
        if (!isPlausibleInstance(index, arch.decl, inst)) continue;
        const resolved = resolveInstance(index, arch.decl, inst);
        const child = node.children.find((c) => c.label !== undefined && lower(c.label) === lower(inst.label));
        const component = inst.kind === 'component' ? index.component(arch.decl, inst.target) : undefined;
        let blockPorts: SchematicPort[];
        if (resolved.entity) blockPorts = resolved.entity.decl.ports.map(toPort);
        else if (component) blockPorts = component.ports.map(toPort);
        else blockPorts = inst.portMap.filter((a) => a.formal).map((a) => ({ name: a.formal!, mode: 'unknown' as const }));
        const byName = new Map(blockPorts.map((p) => [lower(p.name), p]));

        for (const a of inst.portMap) {
            const formal = a.formal ?? blockPorts[a.position]?.name;
            if (formal === undefined) {
                stubs.push({ block: inst.label, port: `#${a.position + 1}`, mode: 'unknown', text: a.actual });
                continue;
            }
            const mode = byName.get(lower(formal))?.mode ?? 'unknown';
            if (a.open) continue;
            const target = a.actualName !== undefined ? lower(a.actualName) : undefined;
            const kind = target === undefined ? undefined : portNames.has(target) ? 'port' : signals.has(target) ? 'signal' : undefined;
            if (target === undefined || kind === undefined) {
                stubs.push({ block: inst.label, port: formal, mode, text: a.actual });
                continue;
            }
            const name = kind === 'port' ? portNames.get(target)!.name : signals.get(target)!.name;
            let net = nets.get(target);
            if (!net) {
                net = { name, kind, endpoints: [] };
                nets.set(target, net);
            }
            net.endpoints.push({ block: inst.label, port: formal, mode, ...(a.simple ? {} : { detail: a.actual }) });
        }

        blocks.push({
            id: inst.label,
            label: inst.label,
            entityName: resolved.entity?.decl.name ?? inst.target,
            status: resolved.status,
            ...(resolved.note ? { note: resolved.note } : {}),
            ports: blockPorts,
            location: { file: arch.file, line: inst.line, col: inst.col },
            ...(resolved.entity ? { entityLocation: { file: resolved.entity.file, line: resolved.entity.decl.line, col: resolved.entity.decl.col } } : {}),
            hierarchyId: child?.id ?? `${node.id}/${inst.label}`,
            childCount: child?.children.length ?? 0,
            generate: inst.generate,
        });
        if (inst.generate.length > 0) notes.push(`${inst.label} is inside generate statement ${inst.generate.join(' / ')} and may be replicated.`);
    }

    // Ports of the level's entity are endpoints of their nets.
    for (const [key, net] of nets) {
        if (net.kind === 'port') net.endpoints.unshift({ port: portNames.get(key)!.name, mode: portNames.get(key)!.mode });
    }
    if (blocks.length === 0) notes.push(`${entity.name} instantiates no blocks; its behaviour is described directly in architecture ${arch.decl.name}.`);
    else notes.push('Only port-map connections are drawn. Signals driven or used by assignments and processes in this architecture appear as labelled stubs.');

    return { ...base, architectureName: arch.decl.name, blocks, nets: [...nets.values()], stubs, notes };
}
