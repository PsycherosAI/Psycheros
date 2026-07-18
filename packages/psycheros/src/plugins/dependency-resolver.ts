/**
 * Inter-plugin dependency resolution.
 *
 * Runs after discovery, before any entrypoint is imported. Resolves the
 * `dependencies` map on each manifest to a load order (deps first), and
 * identifies plugins that can't load because:
 *   - a declared dep is not installed,
 *   - a declared dep's version doesn't satisfy the required range,
 *   - the range string is not a valid semver range, or
 *   - the dependency graph has a cycle.
 *
 * Pure module — no filesystem, no I/O. The caller passes in already-validated
 * manifests and gets back an order plus a failures map. This keeps the
 * resolver trivially testable and lets PluginManager own the side effects
 * (marking plugins degraded, emitting log events).
 */

import * as semver from "@std/semver";

/** Subset of PluginManifest that the resolver needs. */
export interface ResolvablePlugin {
  id: string;
  version: string;
  dependencies?: Record<string, string>;
}

export interface DependencyResolution {
  /**
   * Plugin IDs in load order: deps before dependents. Stable — when there
   * are no other constraints, IDs sort alphabetically so plugin load order
   * is deterministic across runs.
   */
  order: string[];
  /**
   * Plugin IDs that cannot load, mapped to a short human-readable reason.
   * The caller surfaces this via `PluginStatus.lastError` and a load-failure
   * event.
   */
  failures: Record<string, string>;
}

/**
 * Resolve dependencies across a discovered plugin set.
 *
 * Algorithm:
 *   1. For each plugin, verify every declared dep is present and that the
 *      installed version satisfies the declared range. Plugins that fail
 *      this check are excluded from cycle detection / topo sort.
 *   2. Run Kahn's algorithm on the remaining plugins to get a topological
 *      order. Use alphabetical tie-breaking so output is stable.
 *   3. Any plugin not in the final order is either in a cycle or depends on
 *      a cycle — both are reported as "dependency cycle detected".
 */
export function resolveDependencies(
  plugins: ResolvablePlugin[],
): DependencyResolution {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const failures: Record<string, string> = {};

  // Step 1: validate each plugin's declared deps. One failure per plugin —
  // report the first issue, don't pile on.
  const depFailed = new Set<string>();
  for (const plugin of plugins) {
    const deps = plugin.dependencies ?? {};
    for (const [depId, range] of Object.entries(deps)) {
      const dep = byId.get(depId);
      if (!dep) {
        failures[plugin.id] = `requires missing plugin "${depId}"`;
        depFailed.add(plugin.id);
        break;
      }
      try {
        if (
          !semver.satisfies(semver.parse(dep.version), semver.parseRange(range))
        ) {
          failures[plugin.id] =
            `requires "${depId}" ${range}, but ${dep.version} is installed`;
          depFailed.add(plugin.id);
          break;
        }
      } catch (error) {
        failures[plugin.id] =
          `invalid version range for "${depId}" (${range}): ${
            (error as Error).message
          }`;
        depFailed.add(plugin.id);
        break;
      }
    }
  }

  // Step 2: build the dep graph among loadable plugins only. Edges go from
  // a dep to its dependents (B is a dep of A → B must come first → edge B→A).
  const loadable = plugins.filter((p) => !depFailed.has(p.id));
  const loadableIds = new Set(loadable.map((p) => p.id));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const p of loadable) {
    inDegree.set(p.id, 0);
    dependents.set(p.id, []);
  }
  for (const p of loadable) {
    const deps = Object.keys(p.dependencies ?? {}).filter((d) =>
      loadableIds.has(d)
    );
    inDegree.set(p.id, deps.length);
    for (const depId of deps) dependents.get(depId)!.push(p.id);
  }

  // Step 3: Kahn's algorithm with alphabetical tie-breaking. The sort on
  // every iteration is O(n log n) per pop, but plugin counts are tiny
  // (10s at most) so clarity beats micro-optimization here.
  const ready = loadable
    .filter((p) => (inDegree.get(p.id) ?? 0) === 0)
    .map((p) => p.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort();
    const id = ready.shift()!;
    order.push(id);
    for (const dependentId of dependents.get(id) ?? []) {
      const newDeg = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, newDeg);
      if (newDeg === 0) ready.push(dependentId);
    }
  }

  // Step 4: anything left over is in a cycle (or transitively depends on a
  // cycle). Both look identical from the operator's perspective — they
  // need to break a cycle in their plugin set; distinguishing exact cycle
  // membership needs SCC analysis and isn't worth it for the diagnostic.
  for (const p of loadable) {
    if (!order.includes(p.id)) {
      failures[p.id] =
        "dependency cycle detected (or depends on a plugin in a cycle)";
    }
  }

  return { order, failures };
}
