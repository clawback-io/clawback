import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
const CHANNELS_DIR = join(CLAUDE_DIR, "channels", "clawback")

const ConfigSchema = z.object({
  dataDir: z.string().default(CHANNELS_DIR),
  notifications: z.boolean().default(false),
  sessionMessaging: z.boolean().default(true),
  remote: z
    .string()
    .url()
    .refine(
      (url) => {
        try {
          const parsed = new URL(url)
          if (parsed.protocol === "wss:") return true
          if (
            parsed.protocol === "ws:" &&
            (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
          ) {
            return true
          }
          return false
        } catch {
          return false
        }
      },
      {
        message:
          "Remote URL must use wss:// for security. Plain ws:// is only allowed for localhost/127.0.0.1.",
      },
    ),
  connectionToken: z.string().refine((token) => token.startsWith("cbt_"), {
    message: 'Connection token must start with "cbt_".',
  }),
})

export type ClawbackConfig = z.infer<typeof ConfigSchema>

export function getConfigPath(): string {
  return process.env.CLAWBACK_CONFIG ?? join(CHANNELS_DIR, "config.json")
}

export function loadConfig(): ClawbackConfig {
  const configPath = getConfigPath()

  if (!existsSync(configPath)) {
    console.error(`[clawback] Config not found at ${configPath}`)
    console.error(
      "[clawback] Run /clawback:configure <token> or create ~/.claude/channels/clawback/config.json",
    )
    process.exit(1)
  }

  // Check config file permissions on non-Windows platforms
  if (platform() !== "win32") {
    try {
      const stats = statSync(configPath)
      if (stats.mode & 0o077) {
        console.error(
          `[clawback] WARNING: Config file ${configPath} has overly permissive permissions (mode=${(stats.mode & 0o777).toString(8)}). Consider running: chmod 600 ${configPath}`,
        )
      }
    } catch {
      // Ignore stat errors — file existence is already checked above
    }
  }

  try {
    const text = readFileSync(configPath, "utf-8")
    const raw = JSON.parse(text)
    const config = ConfigSchema.parse(raw)

    // Warn when using unencrypted ws:// even for localhost
    try {
      const parsed = new URL(config.remote)
      if (parsed.protocol === "ws:") {
        console.error(
          "[clawback] WARNING: Using unencrypted ws:// connection. This is acceptable for local development only.",
        )
      }
    } catch {
      // URL already validated by schema
    }

    return config
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
