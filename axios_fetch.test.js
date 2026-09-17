const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { axiosFetch } = require("./axios_fetch");

test("axiosFetch sends fetch-style requests through Axios", async (t) => {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["x-request-id"], "axios-test");
      assert.equal(body, '{"vacancy":"backend"}');

      response.writeHead(201, {
        "content-type": "application/json",
        "x-transport": "axios",
      });
      response.end('{"accepted":true}');
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const response = await axiosFetch(`http://127.0.0.1:${port}/requests`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "axios-test",
    },
    body: '{"vacancy":"backend"}',
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-transport"), "axios");
  assert.deepEqual(await response.json(), { accepted: true });
});
