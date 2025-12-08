import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.CLAUDE_API_KEY;
const model = process.env.CLAUDE_MODEL;

const client = new Anthropic({ apiKey });

async function run() {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 200,
      messages: [
        { role: "user", content: "Hello Claude! Test message." }
      ],
    });

    console.log(JSON.stringify(response, null, 2));
  } catch (err) {
    console.error("Error:", err);
  }
}

run();

