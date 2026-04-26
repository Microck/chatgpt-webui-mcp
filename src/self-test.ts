import { ChatgptWebuiClient } from "./chatgpt-webui-client.js";

import { readFile } from "node:fs/promises";

function readFlagValue(flag: string): string | null {
  const args = process.argv.slice(2);
  const direct = args.find((entry) => entry.startsWith(`${flag}=`));
  if (direct) {
    return direct.slice(flag.length + 1).trim() || null;
  }

  const idx = args.indexOf(flag);
  if (idx >= 0) {
    const value = String(args[idx + 1] ?? "").trim();
    return value || null;
  }

  return null;
}

function hasFlag(flag: string): boolean {
  const args = process.argv.slice(2);
  return args.includes(flag);
}

async function resolveSessionToken(): Promise<string> {
  const cliToken = readFlagValue("--token");
  if (cliToken) {
    return cliToken;
  }

  const envToken = String(process.env.CHATGPT_SESSION_TOKEN ?? "").trim();
  if (envToken) {
    return envToken;
  }

  const envTokenFile = String(process.env.CHATGPT_SESSION_TOKEN_FILE ?? "").trim();
  const tokenFile = readFlagValue("--token-file") ?? (envTokenFile || null);
  if (tokenFile) {
    const raw = await readFile(tokenFile, "utf8");
    const fileToken = raw.trim();
    if (fileToken) {
      return fileToken;
    }
  }

  throw new Error(
    "CHATGPT_SESSION_TOKEN is required (env CHATGPT_SESSION_TOKEN, --token, or CHATGPT_SESSION_TOKEN_FILE/--token-file)",
  );
}

async function main(): Promise<void> {
  const token = await resolveSessionToken();
  process.env.CHATGPT_SESSION_TOKEN = token;

  const client = new ChatgptWebuiClient();

  try {
    try {
      const session = await client.getSession();
      const email = session.user?.email ?? "unknown";
      console.log(`[ok] session: ${email}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[warn] session check skipped: ${message}`);
    }

    const instant = await client.ask({
      prompt: "Reply exactly with SELF_TEST_INSTANT_OK",
      modelMode: "instant",
      waitTimeoutMs: 300000,
    });
    if (!instant.text.includes("SELF_TEST_INSTANT_OK")) {
      throw new Error(`instant_mismatch: ${instant.text.slice(0, 200)}`);
    }
    console.log("[ok] instant");

    const pro = await client.ask({
      prompt: "Reply exactly with SELF_TEST_PRO_OK",
      modelMode: "pro",
      waitTimeoutMs: 900000,
    });
    if (!pro.text.includes("SELF_TEST_PRO_OK")) {
      throw new Error(`pro_mismatch: ${pro.text.slice(0, 200)}`);
    }
    console.log("[ok] pro");

    const wantsImage =
      hasFlag("--images") || ["1", "true", "yes", "on"].includes(String(process.env.SELF_TEST_IMAGES ?? "").trim());
    if (wantsImage) {
      const image = await client.ask({
        prompt:
          "Create a clean, simple 256x256 PNG app icon: a minimalist chat bubble with a small sparkle. Flat design, 2 colors, high contrast, no text.",
        createImage: true,
        modelMode: "auto",
        waitTimeoutMs: 900000,
      });

      const images = image.images ?? [];
      if (images.length === 0 || !images[0]?.estuaryUrl) {
        console.log(
          "[debug] image result:",
          JSON.stringify({
            conversationId: image.conversationId,
            model: image.model,
            imageUrls: image.imageUrls ?? [],
            images: image.images ?? [],
            hasImageDataUrl: Boolean(image.imageDataUrl),
          }),
        );
        throw new Error(`image_missing_assets: urls=${(image.imageUrls ?? []).length}`);
      }
      console.log(`[ok] images: ${images.length}`);
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error("self-test failed:", error);
  process.exit(1);
});
