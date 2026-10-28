import type { TargetConfig } from './schemas.js';

/**
 * Where a target's pages are served and where their source lives (SPEC §1.2). Most targets have a separate frontend
 * service; a one-process app (server-rendered pages) has none, and its backend serves the pages at its own URL.
 */

/** True when the target has its own frontend service. */
export const hasFrontend = (config: TargetConfig): boolean => config.frontend !== undefined;

/** The URL pages are opened at: the frontend's, or the backend's for a one-process app. */
export const uiBaseUrl = (config: TargetConfig): string => (config.frontend ?? config.backend).baseUrl;

/**
 * Folders (relative to the repo root) holding the page source: the frontend's `sourceRoots` (default its cwd), or for
 * a one-process app the backend's `sourceRoots` (default its cwd).
 */
export const uiSourceRoots = (config: TargetConfig): string[] =>
  config.frontend ? (config.frontend.sourceRoots ?? [config.frontend.cwd]) : (config.backend.sourceRoots ?? [config.backend.cwd]);
