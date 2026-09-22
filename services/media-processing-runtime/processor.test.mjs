import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import sharp from "sharp";
import { processImage } from "./processor.mjs";
import { createMediaServer } from "./server.mjs";

const fixture = async () => sharp({ create: { width: 32, height: 24, channels: 3, background: "#f04" } }).png().toBuffer();

test("Go options control restoration, repair, and automatic super-resolution order", async () => {
  const image = await fixture(), order = [];
  const operations = {
    removeBackground: async (image) => { order.push("matte"); return image; },
    restoreImage: async (image) => { order.push("restore"); return { buffer: image, applied: true }; },
    generativeRepairImage: async (image, target, edit) => { order.push("whole"); await edit(image, 32, 24); return { buffer: image, repaired: true }; },
    calibrateImageResolution: async (image) => { order.push("super"); return { buffer: image, applied: true }; },
  };
  const input = { imageBase64: image.toString("base64"), requestedSize: "32x24", repairPrompt: "user prompt", final: true, transparentMatte: true, restore: true, repair: "whole", superResolution: true };
  const output = await processImage(input, async (edit) => { assert.equal(edit.prompt, "user prompt"); order.push("edit"); return image; }, operations);
  assert.deepEqual(output, image); assert.deepEqual(order, ["restore", "whole", "edit", "matte"]);
  order.length = 0;
  await processImage({ ...input, final: false }, () => assert.fail("choice output must not trigger paid repairs"), operations);
  assert.deepEqual(order, ["matte"]);
  order.length = 0;
  operations.generativeRepairImage = async () => { throw new Error("provider unavailable"); };
  await processImage({ ...input, transparentMatte: false, restore: false }, () => image, operations);
  assert.deepEqual(order, ["super"]);
});

test("real masked outpainting issues byte-only Go callbacks and assembles the returned tiles", async () => {
  const image = await fixture(); let calls = 0;
  const output = await processImage({ imageBase64: image.toString("base64"), requestedSize: "64x48", repairPrompt: "", final: true, repair: "mask" }, async (edit) => {
    calls++; assert.ok(edit.maskBase64); assert.match(edit.prompt, /region/);
    const meta = await sharp(Buffer.from(edit.imageBase64, "base64")).metadata();
    assert.equal(meta.width, edit.width); return Buffer.from(edit.imageBase64, "base64");
  });
  assert.equal(calls, 1); const dimensions = await sharp(output).metadata(); assert.equal(dimensions.width, 64); assert.equal(dimensions.height, 48);
});

test("streaming protocol completes an edit before the request body ends", async () => {
  const image = await fixture();
  const server = createMediaServer(async (input, edit) => edit({ imageBase64: input.imageBase64, width: 32, height: 24, index: 0, prompt: "restore" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const result = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: server.address().port, path: "/process", method: "POST", headers: { "Content-Type": "application/x-ndjson" } }, (response) => {
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          buffer += chunk;
          while (buffer.includes("\n")) {
            const index = buffer.indexOf("\n"), line = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
            if (line.type === "edit") request.write(`${JSON.stringify({ type: "editResult", index: line.index, imageBase64: line.imageBase64 })}\n`);
            if (line.type === "result") { request.end(); resolve(Buffer.from(line.imageBase64, "base64")); }
            if (line.type === "error") { request.end(); reject(new Error("runtime protocol failure")); }
          }
        });
        response.on("error", reject);
      });
      request.on("error", reject);
      request.write(`${JSON.stringify({ imageBase64: image.toString("base64"), requestedSize: "32x24", repairPrompt: "" })}\n`);
    });
    assert.deepEqual(result, image);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
