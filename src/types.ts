export interface Location { file: string; line: number; column: number }
export interface ImportUsage { module: string; locations: Location[] }
export interface Declared { name: string; requirements: string[]; scopes: string[]; conditional: boolean }
export interface Installed { name: string; version: string; modules: string[] }
export interface Inspection {
  manifest: { exists: boolean; name: string; requiresPython?: string; declared: Declared[]; locked: Record<string, string[]>; lockExists: boolean; hasProjectTable: boolean; uvWorkspace: boolean; uvWorkspaceRoot?: string; groups?: string[]; extras?: string[]; previewBlockers?: string[]; lockPackages?: LockPackage[] };
  scan: { imports: ImportUsage[]; filtered: Record<string, string[]>; errors: { file: string; line: number; message: string }[]; fileCount: number; truncated: boolean };
  installed: Installed[]; warnings: string[]; requirements?: RequirementsInfo;
}
export type Confidence = 'high' | 'ambiguous' | 'unknown';
export interface Resolution extends ImportUsage { confidence: Confidence; package?: string; candidates: string[]; reason: string; ignored?: boolean }
export type DependencyStatus = 'ready' | 'missing' | 'undeclared' | 'out-of-sync' | 'possibly-unused' | 'installed-only' | 'conditional' | 'version-drift';
export interface Dependency {
  name: string; used: boolean; declared: boolean; installed: boolean; version?: string;
  lockedVersions: string[]; scopes: string[]; modules: string[]; locations: Location[];
  status: DependencyStatus;
}
export interface PythonInfo { path: string; version: string; major: number; minor: number; platform: string; machine: string; stdlib: string[] }
export interface EnvironmentInfo { analysisPython: PythonInfo; python?: PythonInfo; venvPath: string; venvExists: boolean; uvVersion?: string; uvError?: string; cacheDir?: string; pythonError?: string }
export interface EditorInterpreter { path?: string; version?: string; status: 'aligned' | 'mismatch' | 'unavailable' | 'invalid'; detail?: string }
export interface DependencySelection { extras: string[]; groups: string[]; noDev: boolean }
export interface ProjectState { root: string; environment: EnvironmentInfo; inspection: Inspection; resolutions: Resolution[]; dependencies: Dependency[]; scannedAt: string; editor?: EditorInterpreter; selection?: DependencySelection }
export interface ServiceOptions { root: string; helperPath: string; pythonPath?: string; uvPath?: string; maxFiles?: number; exclude?: string[]; mappings?: Record<string, string>; ignored?: string[]; log?: (text: string) => void; selection?: DependencySelection; onProgress?: (stage: string) => void }
export interface CachePackage { present: boolean; versions: string[] }
export interface PreviewItem { name: string; version?: string; directWheelBytes?: number; filename?: string; cached?: CachePackage; error?: string; direct?: boolean }
export interface LockPackage { name: string; version: string; source?: Record<string, unknown>; wheels?: { url?: string; size?: number }[] }
export interface RequirementsInfo { exists: boolean; entries: string[]; unsupported: { line: number; text: string; reason: string }[] }
export interface PlanChange { name: string; from?: string; to?: string; action: 'install' | 'replace' | 'remove' }
export type PreviewKind = 'add' | 'sync' | 'requirements' | 'repair' | 'upgrade';
export interface LockChange { name: string; before: string[]; after: string[] }
export interface UpgradeInfo { name: string; installed: string; constraints: string[]; target: string[]; lockChanges: LockChange[] }
export interface Preview {
  items: PreviewItem[]; cacheDir?: string; cacheSupported: boolean; note: string;
  kind?: PreviewKind; requested?: string[]; changes?: PlanChange[]; fingerprint?: string;
  root?: string; manifestText?: string; lockText?: string; createdAt?: string; selection?: DependencySelection;
  environmentAction?: string; scope?: string;
  upgrade?: UpgradeInfo;
}
export interface ReportBase { root: string; fingerprint: string; checkedAt: string }
export interface TreeReport extends ReportBase { name?: string; forward: string; reverse?: string; truncated: boolean }
export interface HealthReport extends ReportBase { status: 'healthy' | 'issues'; output: string }
export interface UpdateItem { name: string; version: string; latest: string }
export interface UpdatesReport extends ReportBase { items: UpdateItem[] }
export interface MaintenanceReports { tree?: TreeReport; health?: HealthReport; updates?: UpdatesReport }
export type ErrorCategory = 'network' | 'python' | 'conflict' | 'wheel' | 'stale' | 'config' | 'unknown';
export interface RecoveryInfo { category: ErrorCategory; title: string; advice: string; canRepair: boolean; stage?: string; changedPackages?: string[] }
