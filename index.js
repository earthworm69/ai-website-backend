require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Hardcoded Credentials (Personal Use)
const USERNAME = "admin";
const PASSWORD = "yourpassword";
const AUTH_TOKEN = "super-secret-dashboard-token-123";

// API Key Rotation Setup
const API_KEYS = [
  process.env.AIML_API_KEY_1,
  process.env.AIML_API_KEY_2,
  process.env.AIML_API_KEY_3,
  process.env.AIML_API_KEY_4,
  process.env.AIML_API_KEY_5
].filter(Boolean);

let currentKeyIndex = 0;

// Safety check
if (API_KEYS.length === 0) {
  console.error('CRITICAL ERROR: No AIMLAPI keys found in .env (AIML_API_KEY_1 to 5).');
  console.error('Please add at least one key and restart the server.');
  process.exit(1);
}

// Helper: Mask key for logging
const maskKey = (key) => `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;

// Helper: Get next key in rotation
const getNextKey = () => {
  const key = API_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  return key;
};

// Helper: Generate API headers
const getHeaders = (apiKey) => ({
  'Authorization': `Bearer ${apiKey}`,
  'Content-Type': 'application/json'
});

const BASE_URL = 'https://api.aimlapi.com';

/**
 * Robust Fetch with Key Rotation and Retries
 * Retries on 401 (Unauthorized) or 429 (Rate Limit)
 */
async function fetchWithRetry(url, options, maxRetries = API_KEYS.length) {
  let attempt = 0;

  while (attempt < maxRetries) {
    const currentKey = API_KEYS[currentKeyIndex];
    const headers = getHeaders(currentKey);
    console.log(`[Attempt ${attempt + 1}] Using Key: ${maskKey(currentKey)} (Index: ${currentKeyIndex})`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      });

      const data = await response.json();
      clearTimeout(timeoutId);

      // If key is rate limited (429) or invalid (401), rotate and retry
      if (response.status === 429 || response.status === 401) {
        console.warn(`[WARNING] Key ${maskKey(currentKey)} failed with status ${response.status}. Rotating...`);
        currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
        attempt++;
        continue;
      }

      // If it's a success or a different kind of error (e.g., 400 Bad Request), return it
      return { response, data };

    } catch (error) {
      clearTimeout(timeoutId);
      const isTimeout = error.name === 'AbortError';
      console.error(`Fetch error (Key Index ${currentKeyIndex}): ${isTimeout ? 'Timed out' : error.message}`);
      
      // On network errors or timeouts, we might want to rotate and retry
      currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
      attempt++;
    }
  }

  throw new Error('All available API keys failed after multiple retries.');
}

// --- Middleware ---

app.use(cors());
app.use(express.json());

// Auth Middleware: Verify Bearer Token
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${AUTH_TOKEN}`) {
    next();
  } else {
    console.warn(`[UNAUTHORIZED] Blocked request from ${req.ip} to ${req.originalUrl}`);
    res.status(401).json({ error: 'Unauthorized: Invalid or missing token.' });
  }
};

// --- Endpoints ---

/**
 * POST /login
 * Simple Dashboard Login
 */
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    console.log(`[LOGIN] User "${username}" successfully logged in.`);
    res.json({ token: AUTH_TOKEN });
  } else {
    console.warn(`[FAILED LOGIN] Attempt by "${username}"`);
    res.status(401).json({ error: 'Invalid username or password.' });
  }
});

/**
 * POST /generate-image
 * (PROTECTED) Generates AI image with model selection
 */
app.post('/generate-image', authMiddleware, async (req, res) => {
  const { prompt, model } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

  const selectedModel = model || 'stable-diffusion-xl';

  try {
    console.log(`[IMAGE] Request: "${prompt}" | Model: "${selectedModel}"`);
    const { response, data } = await fetchWithRetry(`${BASE_URL}/v1/images/generations`, {
      method: 'POST',
      body: JSON.stringify({
        model: selectedModel,
        prompt: prompt,
        n: 1,
        size: '1024x1024'
      })
    });

    if (!response.ok) {
      console.error('[IMAGE ERR] API returned:', JSON.stringify(data, null, 2));
      return res.status(response.status).json({ 
        error: data.error?.message || 'Failed to generate image', 
        details: data 
      });
    }

    res.json({ imageUrl: data.data?.[0]?.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /generate-video
 * (PROTECTED) Starts video generation
 */
app.post('/generate-video', authMiddleware, async (req, res) => {
  const { prompt, model } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

  const selectedModel = model || 'kling-video/v1/standard/text-to-video';

  try {
    console.log(`[VIDEO] Request: "${prompt}" | Model: "${selectedModel}"`);
    const { response, data } = await fetchWithRetry(`${BASE_URL}/v2/video/generations`, {
      method: 'POST',
      body: JSON.stringify({ model: selectedModel, prompt })
    });

    if (!response.ok) {
      console.error('[VIDEO ERR] API returned:', JSON.stringify(data, null, 2));
      return res.status(response.status).json({ 
        error: data.error?.message || 'Failed to start video generation', 
        details: data 
      });
    }

    res.json({ job_id: data.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /video-status/:id
 * (PROTECTED) Polls video job status
 */
app.get('/video-status/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    console.log(`[STATUS] Checking job: ${id}`);
    const { response, data } = await fetchWithRetry(`${BASE_URL}/v2/video/generations?id=${id}`, {
      method: 'GET'
    });

    if (!response.ok) {
      console.error('[STATUS ERR] API returned:', JSON.stringify(data, null, 2));
      return res.status(response.status).json({ 
        error: data.error?.message || 'Failed to fetch status', 
        details: data 
      });
    }

    const videoUrl = data.video?.url || data.output?.video_url || data.data?.video_url || null;
    res.json({ status: data.status, videoUrl, raw: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Basic health check
app.get('/', (req, res) => res.send('AI Generation Backend (v2) is running'));

// Start Server
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`🚀 Server Running on http://localhost:${PORT}`);
  console.log(`🔑 Available Keys: ${API_KEYS.length}`);
  console.log(`🔒 Dashboard Auth Enabled`);
  console.log(`========================================\n`);
});
