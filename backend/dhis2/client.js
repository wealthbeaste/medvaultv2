'use strict';
const axios = require('axios');

function makeClient({ base_url, username, password }) {
  return axios.create({
    baseURL: base_url,
    auth: { username, password },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

async function testConnection({ base_url, username, password }) {
  try {
    const client = makeClient({ base_url, username, password });
    const res = await client.get('/api/me.json');
    return { success: true, username: res.data?.username || username, message: 'Connected successfully.' };
  } catch (e) {
    const status = e.response?.status;
    if (status === 401) return { success: false, error: 'Invalid username or password.' };
    if (status === 404) return { success: false, error: 'Base URL looks wrong — /api/me.json was not found there.' };
    return { success: false, error: e.message };
  }
}

async function pushDataValueSet({ base_url, username, password }, dataValueSet) {
  try {
    const client = makeClient({ base_url, username, password });
    const res = await client.post('/api/dataValueSets', dataValueSet);
    const summary = res.data?.importCount || {};
    return { success: true, imported: summary.imported || 0, updated: summary.updated || 0, ignored: summary.ignored || 0 };
  } catch (e) {
    return { success: false, error: e.response?.data?.message || e.message };
  }
}

module.exports = { testConnection, pushDataValueSet };
