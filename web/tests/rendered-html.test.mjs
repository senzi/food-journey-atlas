import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function getWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

function environment(overrides = {}) {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
    ...overrides,
  };
}

const context = {
  waitUntil() {},
  passThroughOnException() {},
};

test("server-renders the atlas home page", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(
    new Request("http://localhost/"),
    environment(),
    context,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>陈晓卿美食足迹地图<\/title>/);
  assert.match(html, /正在展开旅程档案/);
});

test("server-renders the natural-language journey form", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(
    new Request("http://localhost/recreate"),
    environment(),
    context,
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /"pathname":"\/recreate"/);

  const assetsUrl = new URL("../dist/client/assets/", import.meta.url);
  const assetNames = await readdir(assetsUrl);
  const atlasAsset = assetNames.find(
    (name) => name.startsWith("AtlasApp-") && name.endsWith(".js"),
  );
  assert.ok(atlasAsset, "AtlasApp client asset was not built");
  const clientCode = await readFile(new URL(atlasAsset, assetsUrl), "utf8");
  assert.match(clientCode, /复刻一段美食旅程/);
  assert.match(clientCode, /先说说你的想法/);
  assert.match(clientCode, /帮我填入条件/);
});

test("journey-query API validates input before calling the model", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/journey-query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    }),
    environment(),
    context,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "请先写一句你的想法" });
});

test("journey-query API keeps the model key on the server", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/journey-query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "2024 年去成都吃川菜",
        options: {
          regions: [
            {
              key: "四川省::成都市",
              label: "成都市",
              province: "四川省",
            },
          ],
          years: [2024],
          keywords: [{ name: "川菜", type: "菜系" }],
        },
      }),
    }),
    environment(),
    context,
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "服务端还没有配置 DeepSeek 密钥",
  });
});
