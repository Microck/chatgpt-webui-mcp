import { ChatgptWebuiClient } from "./chatgpt-webui-client.js";

async function main(): Promise<void> {
  const token = String(process.env.CHATGPT_SESSION_TOKEN ?? "").trim();
  if (!token) {
    throw new Error("CHATGPT_SESSION_TOKEN is required");
  }

  const client = new ChatgptWebuiClient();

  try {
    const session = await client.getSession();
    const email = session.user?.email ?? "unknown";
    console.log(`[ok] session: ${email}`);

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
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error("self-test failed:", error);
  process.exit(1);
});
