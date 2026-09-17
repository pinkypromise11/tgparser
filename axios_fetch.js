const axios = require("axios");

/**
 * Fetch-compatible transport backed by Axios.
 *
 * The OpenAI SDK accepts a custom fetch implementation, so this lets the
 * existing client retain its API while all of its HTTP traffic goes through
 * Axios.
 */
async function axiosFetch(input, init) {
  const request = new Request(input, init);
  const hasBody = !["GET", "HEAD"].includes(request.method);
  const data = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;

  const response = await axios({
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    data,
    responseType: "arraybuffer",
    signal: request.signal,
    validateStatus: () => true,
  });

  return new Response(response.data, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

module.exports = { axiosFetch };
