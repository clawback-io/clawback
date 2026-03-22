import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { CronDefinition } from "./types.js"

export class CronStore {
  private filePath: string

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "crons.json")
  }

  load(): CronDefinition[] {
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

  save(crons: CronDefinition[]): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(crons, null, 2))
    renameSync(tmp, this.filePath)
  }

  add(def: Omit<CronDefinition, "id" | "createdAt">): CronDefinition {
    const cron: CronDefinition = {
      ...def,
      id: crypto.randomUUID().slice(0, 12),
      createdAt: new Date().toISOString(),
    }
    const crons = this.load()
    crons.push(cron)
    this.save(crons)
    return cron
  }

  remove(id: string): boolean {
    const crons = this.load()
    const filtered = crons.filter((c) => c.id !== id)
    if (filtered.length === crons.length) return false
    this.save(filtered)
    return true
  }

  list(): CronDefinition[] {
    return this.load()
  }
}
