import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface ActivityEntry {
  id: string
  source: string
  path: string
  skill: string
  cronId: string
  summary: string
  dispatchedAt: string
  completedAt: string
  durationMs: number
  queueDepth: number
  timedOut: boolean
}

const MAX_ENTRIES = 500

export class ActivityLog {
  private filePath: string

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "activity.json")
  }

  load(): ActivityEntry[] {
    if (!existsSync(this.filePath)) {
      return []
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8"))
      return Array.isArray(raw) ? raw : []
    } catch {
      console.error(`[clawback] Failed to parse ${this.filePath}, starting empty`)
      return []
    }
  }

  append(entry: ActivityEntry): void {
    const entries = this.load()
    entries.push(entry)

    // Cap at MAX_ENTRIES, keeping the most recent
    const trimmed = entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries

    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(trimmed, null, 2))
    renameSync(tmp, this.filePath)
  }

  list(): ActivityEntry[] {
    return this.load()
  }
}
