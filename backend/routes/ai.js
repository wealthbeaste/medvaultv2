'use strict';
const https = require('https');
const err   = require('./_err');

function callAnthropicAPI(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(body),
        'x-api-key':       process.env.ANTHROPIC_API_KEY,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      },
    }, (apiRes) => {
      let raw = '';
      apiRes.on('data', chunk => { raw += chunk; });
      apiRes.on('end', () => {
        try {
          resolve({ status: apiRes.statusCode || 500, data: JSON.parse(raw || '{}') });
        } catch (_) {
          resolve({ status: apiRes.statusCode || 500, data: { error: 'Invalid AI response', details: raw.slice(0, 500) } });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = function registerAIRoutes(app) {
  app.post('/api/ai/chat', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY)
      return err(res, 503, 'AI_NOT_CONFIGURED', 'AI is not configured. Missing ANTHROPIC_API_KEY.');
    const { messages, system, max_tokens, model } = req.body || {};
    if (!Array.isArray(messages) || !messages.length)
      return err(res, 400, 'AI_BAD_INPUT', 'messages array is required', 'messages');
    try {
      const payload = {
        model:      model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: Number(max_tokens) > 0 ? Number(max_tokens) : 800,
        messages,
      };
      if (typeof system === 'string' && system.trim()) payload.system = system;
      const result = await callAnthropicAPI(payload);
      if (result.status >= 400)
        return err(res, result.status, 'AI_PROVIDER_ERROR', 'AI request failed');
      return res.json(result.data);
    } catch (e) {
      return err(res, 500, 'AI_GATEWAY_ERROR', 'AI gateway error: ' + e.message);
    }
  });
};
