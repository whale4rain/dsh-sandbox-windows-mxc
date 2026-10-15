/**
 * Path identity for the runner's own boundary checks.
 *
 * The checks compare canonical directories, not the spellings the harness
 * happened to pass, because a Windows path has many spellings (short names,
 * junctions, `\\?` prefixes, mixed case) and a boundary that compares
 * spellings can be talked around. This mirrors the shipped windows-acl rung's
 * path-boundary module: same intent, no shared code, because the runner must
 * load without the harness's packages.
 *
 * @module dsh-sandbox-windows-mxc/paths
 */

import { realpathSync } from 'node:fs'

/** The platform separator the containment comparison uses (Windows). */
const SEPARATOR = '\\'

/**
 * Resolve a path to the spelling the filesystem actually has.
 * @param path - the path to canonicalize.
 * @returns the canonical path, or the input when resolution fails (a missing
 *   path matches nothing, which is the conservative outcome).
 */
export function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Whether `child` is the same directory as `parent` or lives under it,
 * compared case-insensitively with a separator-aware prefix test.
 * @param parent - the containing directory.
 * @param child - the candidate descendant.
 * @returns whether the containment holds.
 */
export function isSameOrInside(parent, child) {
  const outer = canonicalPath(parent).toUpperCase()
  const inner = canonicalPath(child).toUpperCase()
  return inner === outer || inner.startsWith(outer.endsWith(SEPARATOR) ? outer : `${outer}${SEPARATOR}`)
}

/**
 * Refuse a temp root that would sit inside the workspace.
 *
 * `workspace-write` promises the workspace plus a backend-defined temp area
 * outside it; a temp root nested in the workspace makes the two grants
 * indistinguishable and lets one workspace-wide policy authorize the other's
 * files, so the runner fails closed instead of guessing.
 * @param workspaceRoot - the policy's workspace boundary.
 * @param tempRoot - the ambient temp root this call would grant.
 * @throws Error naming both paths when they overlap.
 */
export function assertTempRootOutsideWorkspace(workspaceRoot, tempRoot) {
  if (isSameOrInside(workspaceRoot, tempRoot)) {
    throw new Error(`the temp root must not be the workspace or inside it: workspace=${workspaceRoot} temp=${tempRoot}`)
  }
}
