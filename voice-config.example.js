/**
 * Voice Command Configuration
 * 
 * FOR LOCAL DEVELOPMENT:
 * 1. Copy this file to voice-config.js
 * 2. Get your Hugging Face token from: https://huggingface.co/settings/tokens
 * 3. Paste your token below
 * 
 * FOR PRODUCTION (GitHub Actions):
 * - The token is injected automatically from GitHub secrets
 * - Add HF_TOKEN to your repository's secrets at: Settings > Secrets > Actions
 * 
 * Note: voice-config.js is in .gitignore and should NEVER be committed!
 */

export const HF_TOKEN = 'YOUR_HUGGING_FACE_TOKEN_HERE';
