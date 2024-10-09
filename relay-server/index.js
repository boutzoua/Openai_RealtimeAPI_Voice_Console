import { RealtimeRelay } from './lib/relay.js';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const OPENAI_API_KEY = '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';

if (!OPENAI_API_KEY) {
  console.error(
    `Environment variable "OPENAI_API_KEY" is required.\n` +
      `Please set it in your .env file.`
  );
  process.exit(1);
}

const PORT = parseInt(process.env.PORT) || 8081;

const relay = new RealtimeRelay(OPENAI_API_KEY);
relay.listen(PORT);
