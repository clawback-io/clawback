import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const ConfigSchema = z.object({
  dataDir: z.string().default(join(homedir(), ".clawback")),
  webhookPort: z.number().default(18788),
  webhookHost: z.string().default("127.0.0.1"),
  skills: z.record(z.string(), z.string()).default({}),
  remote: z.string().url().optional(),
  connectionToken: z.string().optional(),
}).refine(
  (c) => !c.remote || c.connectionToken,
  { message: "connectionToken is required when remote is set", path: ["connectionToken"] },
)

export type ClawbackConfig = z.infer<typeof ConfigSchema>

export function loadConfig(): ClawbackConfig {
  const configPath = process.env.CLAWBACK_CONFIG ?? join(homedir(), ".clawback", "config.json")

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
