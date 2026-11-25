import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const IGNORED_EDITOR_FILES = new Set(["AGENTS.md", "GEMINI.md", "CLAUDE.md"]);

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function normalizeRelPath(relPath: string): string {
  const clean = path.posix.normalize(relPath.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!clean || clean === "." || clean.startsWith("..") || clean.includes("/../")) {
    throw new Error(`Invalid relative path: ${relPath}`);
  }
  return clean;
}

/**
 * Bidirectional sync between Web Workbench project state and a local disk
 * mirror directory so local ACP agents can use native read/grep/edit tools
 * while every change streams back to browser preview without echo loops.
 */
export class LocalWorkspaceSync {
  readonly workspaceDir: string;
  private readonly projectId: string;
  private readonly fileHashes = new Map<string, string>();
  private readonly onLocalChange: (path: string, content: string, revision: number) => void;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private revision = 0;

  constructor(params: {
    workspaceRoot: string;
    projectId: string;
    onLocalChange: (relPath: string, content: string, revision: number) => void;
  }) {
    this.projectId = params.projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.workspaceDir = path.resolve(params.workspaceRoot, this.projectId);
    this.onLocalChange = params.onLocalChange;
    fs.mkdirSync(this.workspaceDir, { recursive: true });
  }

  getRevision(): number {
    return this.revision;
  }

  syncFromWeb(files: Record<string, string>, revision: number): void {
    this.revision = Math.max(this.revision, revision);
    for (const [relPath, content] of Object.entries(files)) {
      this.writeFromWeb(relPath, content, this.revision);
    }
    this.startWatching();
  }

  writeFromWeb(relPath: string, content: string, revision: number): void {
    const clean = normalizeRelPath(relPath);
    const abs = path.resolve(this.workspaceDir, clean);
    if (!abs.startsWith(this.workspaceDir + path.sep)) return;

    this.revision = Math.max(this.revision, revision);
    const h = hashContent(content);
    if (this.fileHashes.get(clean) === h && fs.existsSync(abs)) {
      return;
    }
    this.fileHashes.set(clean, h);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  /** Force-scan workspace to push any changed files immediately (e.g. after ACP turn ends). */
  flushDiskChanges(): void {
    const walk = (dir: string, prefix = "") => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs, rel);
        else if (entry.isFile()) this.checkAndEmit(rel);
      }
    };
    walk(this.workspaceDir);
  }

  private checkAndEmit(relPath: string): void {
    try {
      const clean = normalizeRelPath(relPath);
      if (
        clean.startsWith(".") ||
        clean.includes("/.") ||
        clean.startsWith("node_modules") ||
        IGNORED_EDITOR_FILES.has(clean)
      ) {
        return;
      }
      const abs = path.resolve(this.workspaceDir, clean);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
      const content = fs.readFileSync(abs, "utf8");
      const h = hashContent(content);
      if (this.fileHashes.get(clean) === h) return;
      this.fileHashes.set(clean, h);
      this.revision += 1;
      this.onLocalChange(clean, content, this.revision);
    } catch {
      // ignore transient write errors while atomic saves occur
    }
  }

  private startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.workspaceDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, "/");
        const existing = this.debounceTimers.get(rel);
        if (existing) clearTimeout(existing);
        this.debounceTimers.set(
          rel,
          setTimeout(() => {
            this.debounceTimers.delete(rel);
            this.checkAndEmit(rel);
          }, 90),
        );
      });
    } catch {
      // Fallback: flushDiskChanges() still runs after every ACP prompt
    }
  }

  close(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.watcher?.close();
    this.watcher = null;
  }
}
