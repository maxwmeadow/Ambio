// User preferences. Stored in ~/.axiom/settings.json beside other app state
// (the resume marker lives there too), so unknown keys are always preserved.

export interface AppSettings {
  /** Open the project you last had open when Axiom starts. */
  reopenLastProject: boolean
  /** Look for new versions on GitHub Releases in the background. */
  checkForUpdates: boolean
  /** Interface zoom factor, 0.8-1.5. */
  uiZoom: number
  /** 'system' follows the OS setting; 'always' reduces motion regardless. */
  reduceMotion: 'system' | 'always'
  /** Show Reload and Developer Tools in the View menu. */
  developerMenu: boolean
  /** Where "Open in Editor" opens source files: 'auto' or an editor id. */
  editor: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  reopenLastProject: true,
  checkForUpdates: true,
  uiZoom: 1,
  reduceMotion: 'system',
  developerMenu: false,
  editor: 'auto',
}

export const UI_ZOOM_MIN = 0.8
export const UI_ZOOM_MAX = 1.5
export const UI_ZOOM_STEP = 0.1

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.round(Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, value)) * 100) / 100
}

/** Settings from whatever is on disk: invalid values fall back to defaults. */
export function normalizeSettings(raw: unknown): AppSettings {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const bool = (key: keyof AppSettings) =>
    typeof source[key] === 'boolean' ? source[key] as boolean : DEFAULT_SETTINGS[key] as boolean
  return {
    reopenLastProject: bool('reopenLastProject'),
    checkForUpdates: bool('checkForUpdates'),
    uiZoom: typeof source.uiZoom === 'number' ? clampZoom(source.uiZoom) : DEFAULT_SETTINGS.uiZoom,
    reduceMotion: source.reduceMotion === 'always' ? 'always' : 'system',
    developerMenu: bool('developerMenu'),
    editor: typeof source.editor === 'string' && /^[a-z0-9-]{1,32}$/.test(source.editor) ? source.editor : 'auto',
  }
}

/** Apply a patch, keeping only known keys with valid values. */
export function patchSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return normalizeSettings({ ...current, ...patch })
}
