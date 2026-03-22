import { Cron } from "croner"
import type { CronDefinition } from "./types.js"

export type EmitFn = (
  content: string,
  meta: Record<string, string>,
) => Promise<void>

export class CronScheduler {
  private jobs = new Map<string, Cron>()
  private emitFn: EmitFn

  constructor(emitFn: EmitFn) {
    this.emitFn = emitFn
  }

  startAll(definitions: CronDefinition[]): void {
    for (const def of definitions) {
      this.start(def)
    }
  }

  start(def: CronDefinition): void {
    // Stop existing job with same ID if any
    this.stop(def.id)

    const job = new Cron(def.schedule, async () => {
      try {
        await this.emitFn(def.prompt, {
          source: "cron",
          cronId: def.id,
          label: def.label ?? "",
          schedule: def.schedule,
        })
      } catch (err) {
        console.error(
          `[clawback] Cron ${def.id} (${def.label ?? def.schedule}) notification failed:`,
          err,
        )
      }
    })

    this.jobs.set(def.id, job)
    console.error(
      `[clawback] Cron started: ${def.id} "${def.label ?? def.schedule}" → ${def.prompt}`,
    )
  }

  stop(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    job.stop()
    this.jobs.delete(id)
    console.error(`[clawback] Cron stopped: ${id}`)
    return true
  }

  stopAll(): void {
    for (const [id, job] of this.jobs) {
      job.stop()
      console.error(`[clawback] Cron stopped: ${id}`)
    }
    this.jobs.clear()
  }
}
