import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { handleJourneyQuery } from "../lib/journey-query.ts";

test("build produces a directly deployable Pages root", async () => {
  const html = await readFile(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /<title>陈晓卿美食足迹地图<\/title>/);
  assert.match(html, /<div id="root"><\/div>/);

  const rootFiles = await readdir(new URL("../dist/", import.meta.url));
  assert.ok(rootFiles.includes("assets"));
  assert.ok(rootFiles.includes("data"));
  assert.ok(!rootFiles.includes("client"));
  assert.ok(!rootFiles.includes("server"));
  assert.ok(!rootFiles.includes("404.html"));
});

test("static client contains the journey experience", async () => {
  const assetsUrl = new URL("../dist/assets/", import.meta.url);
  const assetNames = await readdir(assetsUrl);
  const clientAsset = assetNames.find((name) => name.endsWith(".js"));
  assert.ok(clientAsset, "client JavaScript asset was not built");
  const clientCode = await readFile(new URL(clientAsset, assetsUrl), "utf8");
  assert.match(clientCode, /复刻一段美食旅程/);
  assert.match(clientCode, /理解并生成旅程/);
  assert.match(clientCode, /2025年 厦门市 · 综合寻味/);
});

test("journey-query handler validates input before calling the model", async () => {
  const response = await handleJourneyQuery(
    new Request("http://localhost/api/journey-query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    }),
    {},
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "请先写一句你的想法" });
});

test("journey-query handler keeps the model key server-side", async () => {
  const response = await handleJourneyQuery(
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
    {},
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "服务端还没有配置 DeepSeek 密钥",
  });
});
