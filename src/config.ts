import { z } from "zod"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const ConfigSchema = z.object({
  dataDir: z.string().default(join(homedir(), ".clawback")),
  webhookPort: z.number().default(18788),
  webhookHost: z.string().default("127.0.0.1"),
  skills: z.record(z.string(), z.string()).default({}),
})

export type ClawbackConfig = z.infer<typeof ConfigSchema>

export function loadConfig(): ClawbackConfig {
  const configPath =
    process.env.CLAWBACK_CONFIG ?? join(homedir(), ".clawback", "config.json")

  if (!existsSync(configPath)) {
    return ConfigSchema.parse({})
  }

  try {
    const text = readFileSync(configPath, "utf-8")
    const raw = JSON.parse(text)
    return ConfigSchema.parse(raw)
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error(`[clawback] Invalid config at ${configPath}:`)
      for (const issue of err.issues) {
        console.error(`  ${issue.path.join(".")}: ${issue.message}`)
      }
      process.exit(1)
    }
    console.error(`[clawback] Failed to read config at ${configPath}:`, err)
    process.exit(1)
  }
}
