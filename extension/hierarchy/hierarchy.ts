import type { DesignIndex, Located } from './design-index';
import type { ArchitectureDecl, EntityDecl, InstanceDecl } from './vhdl-parser';

export interface NodeLocation {
    readonly file: string;
    readonly line: number;
    readonly col: number;
}

/**
 * - `ok`: resolved to an entity in the project
 * - `external`: instantiates a unit from another library (e.g. a vendor primitive)
 * - `unresolved`: no matching entity in the project
 * - `recursive`: the entity already appears above this node
 */
export type NodeStatus = 'ok' | 'external' | 'unresolved' | 'recursive';

export interface HierarchyNode {
    /** Stable id: instance-label path from the root, e.g. `top/u_display/u_mux`. */
    readonly id: string;
    readonly kind: 'entity' | 'instance';
    /** Instance label (instances only). */
    readonly label?: string;
    /** Entity/component name: the declaration's spelling when resolved, otherwise as referenced. */
    readonly entityName: string;
    readonly entity?: Located<EntityDecl>;
    /** Architecture whose body was walked for children. */
    readonly architecture?: Located<ArchitectureDecl>;
    readonly instance?: InstanceDecl;
    /** Where clicking the node goes: the instantiation for instances, the entity for roots. */
    readonly location?: NodeLocation;
    readonly status: NodeStatus;
    readonly note?: string;
    readonly children: readonly HierarchyNode[];
}

export interface HierarchyModel {
    /** Configured top entity name. */
    readonly top: string;
    /** Hierarchy from the top entity; absent when the top entity is not found. */
    readonly root?: HierarchyNode;
    /** RTL entities not instantiated (directly or indirectly) by the top. */
    readonly unreachable: readonly Located<EntityDecl>[];
    /** Hierarchies rooted at simulation entities that have no ports (testbenches). */
    readonly testbenches: readonly HierarchyNode[];
}

const MAX_DEPTH = 32;

/** Resolves an instantiation to the entity it binds to. */
export function resolveInstance(index: DesignIndex, arch: ArchitectureDecl, inst: InstanceDecl): { entity?: Located<EntityDecl>; status: NodeStatus; note?: string } {
    if (inst.kind === 'configuration') {
        return { status: 'unresolved', note: 'configuration instantiation is not followed by the hierarchy view' };
    }
    const lib = inst.library?.toLowerCase();
    if (lib !== undefined && lib !== 'work') {
        return { status: 'external', note: `from library ${inst.library}` };
    }
    const entity = index.entity(inst.target);
    if (entity) return { entity, status: 'ok' };
    if (inst.kind === 'component' && index.component(arch, inst.target)) {
        return { status: 'unresolved', note: 'component declared, but no entity with this name is in the project' };
    }
    return { status: 'unresolved', note: 'no entity with this name is in the project' };
}

/**
 * Whether an instantiation should be shown. A bare `label : name;` (no maps,
 * no `component` keyword) is also the syntax of a labelled procedure call,
 * so it is only shown when it names a known entity or component.
 */
export function isPlausibleInstance(index: DesignIndex, arch: ArchitectureDecl, inst: InstanceDecl): boolean {
    if (!inst.implicitComponent || inst.hasPortMap || inst.hasGenericMap) return true;
    return index.entity(inst.target) !== undefined || index.component(arch, inst.target) !== undefined;
}

function buildNode(
    index: DesignIndex,
    entity: Located<EntityDecl>,
    id: string,
    ancestors: ReadonlySet<string>,
    depth: number,
    visited: Set<string>,
    base: Omit<HierarchyNode, 'id' | 'children' | 'status' | 'entityName' | 'entity' | 'architecture'>,
    architectureName?: string,
): HierarchyNode {
    const name = entity.decl.name.toLowerCase();
    visited.add(name);
    const architecture = index.architectureFor(entity.decl.name, architectureName);
    const common = { ...base, id, entityName: entity.decl.name, entity, ...(architecture ? { architecture } : {}) };
    if (ancestors.has(name)) return { ...common, status: 'recursive', note: 'recursive instantiation', children: [] };
    if (depth >= MAX_DEPTH) return { ...common, status: 'ok', note: 'hierarchy too deep to show', children: [] };
    if (!architecture) {
        const note = architectureName ? `architecture ${architectureName} not found` : 'no architecture found';
        return { ...common, status: 'ok', note, children: [] };
    }

    const inner = new Set(ancestors).add(name);
    const children: HierarchyNode[] = [];
    for (const inst of architecture.decl.instances) {
        if (!isPlausibleInstance(index, architecture.decl, inst)) continue;
        const childId = `${id}/${inst.label}`;
        const location = { file: architecture.file, line: inst.line, col: inst.col };
        const childBase = { kind: 'instance' as const, label: inst.label, instance: inst, location };
        const resolved = resolveInstance(index, architecture.decl, inst);
        if (resolved.entity) {
            children.push(buildNode(index, resolved.entity, childId, inner, depth + 1, visited, childBase, inst.architecture));
        } else {
            children.push({ ...childBase, id: childId, entityName: inst.target, status: resolved.status, ...(resolved.note ? { note: resolved.note } : {}), children: [] });
        }
    }
    return { ...common, status: 'ok', children };
}

function rootNode(index: DesignIndex, entity: Located<EntityDecl>, visited: Set<string>): HierarchyNode {
    const location = { file: entity.file, line: entity.decl.line, col: entity.decl.col };
    return buildNode(index, entity, entity.decl.name, new Set(), 0, visited, { kind: 'entity', location });
}

export function buildHierarchy(index: DesignIndex, top: string): HierarchyModel {
    const visited = new Set<string>();
    const topEntity = index.entity(top);
    const root = topEntity ? rootNode(index, topEntity, visited) : undefined;
    const unreachable = index.entitiesIn('source').filter((e) => !visited.has(e.decl.name.toLowerCase()));

    const simVisited = new Set<string>();
    const testbenches = index
        .entitiesIn('simulation')
        .filter((e) => e.decl.ports.length === 0)
        .map((e) => rootNode(index, e, simVisited));
    return { top, ...(root ? { root } : {}), unreachable, testbenches };
}

/** Depth-first list of nodes (for searching and tests). */
export function flatten(node: HierarchyNode): HierarchyNode[] {
    return [node, ...node.children.flatMap(flatten)];
}

/** Finds a node by its id path. */
export function findNode(root: HierarchyNode | undefined, id: string): HierarchyNode | undefined {
    if (!root) return undefined;
    return flatten(root).find((n) => n.id === id);
}
