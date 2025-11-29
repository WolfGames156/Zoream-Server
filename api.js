/**
 * Vercel'de çalışan Zoream Server API client.
 * CommonJS format. Electron veya Node.js'ten kullanabilirsiniz.
 * 
 * Kullanım:
 *   const { callZoreamServer } = require('./api.js');
 *   callZoreamServer('/active-users').then(data => console.log(data));
 */

async function callZoreamServer(endpoint = '/', options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
  } = options;

  // Vercel'deki deployment URL'si — ortam değişkeninden.
  // Electron'dan çağırırken geçilecek URL (example: https://zoream-server.vercel.app)
  const VERCEL_URL = process.env.VERCEL_URL || process.env.NEXT_PUBLIC_VERCEL_URL || 'https://zoream-server.vercel.app';
  
  // Endpoint normalizasyonu
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  
  // Vercel'deki API endpoint'i
  const url = `${VERCEL_URL.replace(/\/$/, '')}/api${path}`;

  // Request hazırla
  const requestOptions = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (body) {
    requestOptions.body = JSON.stringify(body);
  }

  // Fetch yap
  const response = await fetch(url, requestOptions);

  // Hata kontrolü
  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(
      `API Error ${response.status}: ${errorText || response.statusText}`
    );
    error.status = response.status;
    error.response = response;
    throw error;
  }

  // Response parse et
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

module.exports = { callZoreamServer };
