
import "dotenv/config";

const model = "nvidia/nemotron-3.5-lightning-30b-a3b";
const base = (
  process.env.NVIDIA_CHAT_BASE_URL ||
  "https://integrate.api.nvidia.com/v1"
).replace(/\/$/, "");

async function main() {
  const key = process.env.NVIDIA_API_KEY;

  if (!key) {
    console.log("Missing NVIDIA_API_KEY in .env");
    return;
  }

  const start = Date.now();

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    body: JSON.stringify({
  model,
  messages: [
    { role: "user", content: "Reply with exactly: OK" },
  ],
  max_tokens: 64,
  temperature: 0,
  stream: false,
  chat_template_kwargs: {
    enable_thinking: false,
  },
}),
    });

    const data = await response.json();

    console.log("Model:", model);
    console.log("HTTP status:", response.status);
    console.log("Elapsed:", Date.now() - start, "ms");
    console.log(
      "Content:",
      JSON.stringify(data.choices?.[0]?.message?.content ?? null)
    );

    if (!response.ok) {
      console.log("API error:", JSON.stringify(data, null, 2));
    } else if (!data.choices?.[0]?.message?.content) {
      console.log("Finish reason:", data.choices?.[0]?.finish_reason);
      console.log("Full response:", JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.log("Request failed:", error.message);
    console.log("Elapsed:", Date.now() - start, "ms");
  }
}

main();
