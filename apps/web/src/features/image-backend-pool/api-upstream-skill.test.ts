/**
 * 项目内 API 上游适配 Skill 回归测试。
 *
 * 职责：锁定 Skill 元数据、直接引用和 JavaScript 示例可被生产 QuickJS 编译；
 * 并用生产测试 binding 执行三类媒体金样，防止文档示例静态存在但契约已经失效。
 */
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/uol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/shared/uol")>();
  return { ...actual, bindExecute: vi.fn() };
});

import { executeApiUpstreamAdapterTestBinding } from "@/server/uol-bindings/image-backend-pool";
import { shutdownApiUpstreamScriptPool } from "./api-upstream-script-pool";
import { validateApiUpstreamScript } from "./api-upstream-script-runtime";

const SKILL_DIRECTORY = resolve(
  process.cwd(),
  "../../skills/write-api-upstream-adapter"
);
const SKILL_PATH = resolve(SKILL_DIRECTORY, "SKILL.md");
const REFERENCE_PATHS = [
  "references/runtime-contract.md",
  "references/text-to-image.md",
  "references/image-to-image.md",
  "references/video.md",
] as const;

/** 提取 Markdown 中所有 JavaScript 函数体代码块。 */
function extractJavaScriptBlocks(markdown: string): string[] {
  return Array.from(markdown.matchAll(/```js\s+([\s\S]*?)```/gu), (match) =>
    (match[1] ?? "").trim()
  ).filter(Boolean);
}

/**
 * 提取指定二级章节内的 JavaScript 示例，避免测试另写一套与 Skill 漂移的脚本。
 *
 * @param markdown 完整参考文件内容。
 * @param heading 不含 `##` 的精确章节标题。
 * @returns 按文档顺序排列的 JavaScript 函数体。
 * @throws Error 章节不存在或没有 JavaScript 示例时立即暴露文档结构漂移。
 */
function extractSectionJavaScriptBlocks(
  markdown: string,
  heading: string
): string[] {
  const marker = `## ${heading}`;
  const sectionStart = markdown.indexOf(marker);
  if (sectionStart < 0) throw new Error(`Skill section not found: ${heading}`);
  const contentStart = sectionStart + marker.length;
  const nextSection = markdown.indexOf("\n## ", contentStart);
  const section = markdown.slice(
    contentStart,
    nextSection < 0 ? markdown.length : nextSection
  );
  const scripts = extractJavaScriptBlocks(section);
  if (scripts.length === 0) {
    throw new Error(`Skill section has no JavaScript: ${heading}`);
  }
  return scripts;
}

/** 从指定文字后的首个 JS 代码块提取文档中的供应商脚本，避免测试副本漂移。 */
function extractJavaScriptBlockAfter(markdown: string, marker: string): string {
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Skill marker not found: ${marker}`);
  const match = markdown.slice(markerIndex).match(/```js\s+([\s\S]*?)```/u);
  if (!match?.[1]?.trim()) {
    throw new Error(`Skill marker has no JavaScript: ${marker}`);
  }
  return match[1].trim();
}

/** 读取一个 Skill 参考文件，供金样直接执行文档中的源码。 */
async function readReference(referencePath: (typeof REFERENCE_PATHS)[number]) {
  return await readFile(resolve(SKILL_DIRECTORY, referencePath), "utf8");
}

/** 测试结束后关闭生产 Worker，防止 Vitest 进程残留线程。 */
afterAll(async () => {
  await shutdownApiUpstreamScriptPool();
});

describe("write-api-upstream-adapter skill", () => {
  it("包含有效元数据、UI 配置和四个直接参考文件", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    expect(skill).toMatch(
      /^---\nname: write-api-upstream-adapter\ndescription: .+\n---/u
    );
    for (const referencePath of REFERENCE_PATHS) {
      expect(skill).toContain(`](${referencePath})`);
      await expect(
        access(resolve(SKILL_DIRECTORY, referencePath))
      ).resolves.toBeUndefined();
    }
    const agentMetadata = await readFile(
      resolve(SKILL_DIRECTORY, "agents/openai.yaml"),
      "utf8"
    );
    expect(agentMetadata).toContain("$write-api-upstream-adapter");
    expect(skill).not.toContain("write-api-request-transform");
  });

  it("所有 JavaScript 示例均通过生产 QuickJS 编译", async () => {
    const markdownFiles = [
      SKILL_PATH,
      ...REFERENCE_PATHS.map((path) => resolve(SKILL_DIRECTORY, path)),
    ];
    let exampleCount = 0;
    for (const markdownPath of markdownFiles) {
      const markdown = await readFile(markdownPath, "utf8");
      for (const script of extractJavaScriptBlocks(markdown)) {
        exampleCount += 1;
        await validateApiUpstreamScript(script, "images.generate", "request");
      }
    }
    expect(exampleCount).toBeGreaterThanOrEqual(15);
  });

  it("执行文生图同步、Base64 和异步任务金样", async () => {
    const reference = await readReference("references/text-to-image.md");
    const [requestScript, responseScript] = extractSectionJavaScriptBlocks(
      reference,
      "同步 JSON 供应商"
    );
    const [base64ResponseScript] = extractSectionJavaScriptBlocks(
      reference,
      "Base64 图片响应"
    );
    const [submitResponseScript, queryRequestScript, queryResponseScript] =
      extractSectionJavaScriptBlocks(reference, "异步供应商");

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.generate",
        stage: "request",
        script: requestScript ?? "",
        sample: {
          query: { trace: "synthetic" },
          body: {
            model: "black-forest-labs/flux-pro",
            prompt: "synthetic prompt",
            n: 2,
            width: 1024,
            height: 768,
            response_format: "b64_json",
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        body: {
          model: "black-forest-labs/flux-pro",
          input: { text: "synthetic prompt", width: 1024, height: 768 },
          count: 2,
        },
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.generate",
        stage: "response",
        script: responseScript ?? "",
        sample: {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: {
            result: {
              images: [
                { url: "https://cdn.example.test/image-1.png" },
                { url: "https://cdn.example.test/image-2.png" },
              ],
            },
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        status: "completed",
        outputs: [
          { kind: "image", url: "https://cdn.example.test/image-1.png" },
          { kind: "image", url: "https://cdn.example.test/image-2.png" },
        ],
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.generate",
        stage: "response",
        script: base64ResponseScript ?? "",
        sample: {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: {
            images: [
              {
                base64_data: "mock://media/generated-base64",
                media_type: "image/webp",
              },
            ],
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        status: "completed",
        outputs: [
          {
            kind: "image",
            base64: "mock://media/generated-base64",
            mediaType: "image/webp",
          },
        ],
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.generate",
        stage: "response",
        script: submitResponseScript ?? "",
        sample: {
          statusCode: 202,
          headers: { "content-type": "application/json" },
          body: { job_id: "image-job-1", state: "queued" },
        },
      })
    ).resolves.toEqual({
      preview: { status: "pending", taskId: "image-job-1" },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.generate.query",
        stage: "request",
        script: queryRequestScript ?? "",
        sample: { query: { taskId: "image-job-1" } },
      })
    ).resolves.toEqual({
      preview: {
        query: {
          taskId: "image-job-1",
          include: ["status", "output"],
        },
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.generate.query",
        stage: "response",
        script: queryResponseScript ?? "",
        sample: {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: { state: "processing", progress: 42 },
        },
      })
    ).resolves.toEqual({
      preview: { status: "processing", progress: 42 },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.generate.query",
        stage: "response",
        script: queryResponseScript ?? "",
        sample: {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: {
            state: "completed",
            output: {
              images: [{ url: "https://cdn.example.test/final.png" }],
            },
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        status: "completed",
        outputs: [{ kind: "image", url: "https://cdn.example.test/final.png" }],
      },
    });
  });

  it("执行图生图单图、多图、蒙版和媒体完整性金样", async () => {
    const reference = await readReference("references/image-to-image.md");
    const [imageRenameScript] = extractSectionJavaScriptBlocks(
      reference,
      "单图或多图字段改名"
    );
    const [maskRenameScript] = extractSectionJavaScriptBlocks(
      reference,
      "蒙版与文本字段"
    );

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.edit",
        stage: "request",
        script: imageRenameScript ?? "",
        sample: {
          query: {},
          body: {
            model: "upstream-edit-model",
            prompt: "synthetic edit",
            image: "mock://media/source-single",
            mask: "mock://media/mask-single",
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        body: {
          model: "upstream-edit-model",
          prompt: "synthetic edit",
          source_images: ["mock://media/source-single"],
          mask: "mock://media/mask-single",
        },
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.edit",
        stage: "request",
        script: imageRenameScript ?? "",
        sample: {
          query: {},
          body: {
            model: "upstream-edit-model",
            prompt: "synthetic edit",
            "image[]": ["mock://media/source-1", "mock://media/source-2"],
            mask: "mock://media/mask-1",
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        body: {
          model: "upstream-edit-model",
          prompt: "synthetic edit",
          source_images: ["mock://media/source-1", "mock://media/source-2"],
          mask: "mock://media/mask-1",
        },
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.edit",
        stage: "request",
        script: maskRenameScript ?? "",
        sample: {
          query: {},
          body: {
            prompt: "synthetic edit",
            image: "mock://media/source-1",
            mask: "mock://media/mask-1",
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        body: {
          instruction: "synthetic edit",
          image: "mock://media/source-1",
          edit_mask: "mock://media/mask-1",
        },
      },
    });

    for (const destructiveScript of [
      "const body = { ...request.body }; delete body.image; return { body };",
      "return { body: { ...request.body, copied: request.body.image } };",
    ]) {
      await expect(
        executeApiUpstreamAdapterTestBinding({
          operation: "images.edit",
          stage: "request",
          script: destructiveScript,
          sample: {
            query: {},
            body: { image: "mock://media/protected-image" },
          },
        })
      ).rejects.toMatchObject({ code: "validation_error" });
    }
  });

  it("无网络执行 Seedream 公网 URL 多图和异步响应脚本", async () => {
    const reference = await readReference("references/image-to-image.md");
    const requestScript = extractJavaScriptBlockAfter(
      reference,
      "Seedream 5 的 `images.generate` 与 `images.edit`"
    );
    const submitScript = extractJavaScriptBlockAfter(
      reference,
      "创建响应脚本（`images.generate` 与 `images.edit`）"
    );
    const queryScript = extractJavaScriptBlockAfter(
      reference,
      "查询响应脚本（`images.generate.query` 与 `images.edit.query`）"
    );

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.edit",
        stage: "request",
        script: requestScript,
        sample: {
          query: {},
          body: {
            model: "doubao-seedream-5-0-260128",
            prompt: "edit",
            n: 1,
            image_urls: [
              "https://app.example.test/ref-1.png",
              "https://app.example.test/ref-2.png",
            ],
            aspectRatio: "16:9",
            resolution: "1k",
            response_format: "b64_json",
            stream: true,
            partial_images: 2,
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        body: {
          model: "doubao-seedream-5-0-260128",
          prompt: "edit",
          n: 1,
          image_urls: [
            "https://app.example.test/ref-1.png",
            "https://app.example.test/ref-2.png",
          ],
          aspectRatio: "16:9",
          resolution: "1k",
        },
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.generate",
        stage: "request",
        script: requestScript,
        sample: {
          query: {},
          body: {
            model: "seedream-5.0-pro",
            prompt: "text only",
            n: 1,
            aspectRatio: "1:1",
            resolution: "1k",
            response_format: "b64_json",
            stream: false,
            partial_images: 2,
            quality: "high",
            moderation: "auto",
            output_format: "png",
            output_compression: 80,
            background: "opaque",
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        body: {
          model: "seedream-5.0-pro",
          prompt: "text only",
          n: 1,
          aspectRatio: "1:1",
          resolution: "1k",
        },
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.edit",
        stage: "response",
        script: submitScript,
        sample: {
          statusCode: 202,
          headers: { "content-type": "application/json" },
          body: { id: "generation-1", status: "in_progress" },
        },
      })
    ).resolves.toEqual({
      preview: {
        status: "pending",
        taskId: "generation-1",
        pollAfterSeconds: 5,
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "images.edit.query",
        stage: "response",
        script: queryScript,
        sample: {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: {
            status: "succeeded",
            data: [{ url: "https://cdn.example.test/result.png" }],
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        status: "completed",
        outputs: [
          { kind: "image", url: "https://cdn.example.test/result.png" },
        ],
      },
    });
  });

  it("执行 Seedance 视频参数、11 张参考图、首尾帧和异步任务金样", async () => {
    const reference = await readReference("references/video.md");
    const [basicFieldsScript] = extractSectionJavaScriptBlocks(
      reference,
      "基础字段改名"
    );
    const [mediaScript] = extractSectionJavaScriptBlocks(
      reference,
      "首尾帧和参考图结构"
    );
    const [submitResponseScript, queryRequestScript, queryResponseScript] =
      extractSectionJavaScriptBlocks(reference, "异步视频任务");
    const references = Array.from(
      { length: 11 },
      (_, index) => `mock://media/reference-${index + 1}`
    );

    expect(reference).toContain('"modelId": "seedance2"');
    expect(reference).toContain('"upstreamModelId": "seedande-2.0"');
    expect(reference).toContain('"modelId": "seedance2-fast"');
    expect(reference).toContain('"upstreamModelId": "seedande-2.0-fast"');

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "videos.generate",
        stage: "request",
        script: basicFieldsScript ?? "",
        sample: {
          query: {},
          body: {
            client_request_id: "video-fixture-001",
            model: "seedande-2.0",
            prompt: "synthetic video prompt",
            duration: 8,
            aspect_ratio: "16:9",
            resolution: "1080p",
            generate_audio: true,
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        body: {
          client_request_id: "video-fixture-001",
          model: "seedande-2.0",
          prompt: "synthetic video prompt",
          duration_seconds: 8,
          ratio: "16:9",
          resolution: "1080p",
          audio: { enabled: true },
        },
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "videos.generate",
        stage: "request",
        script: mediaScript ?? "",
        sample: {
          query: {},
          body: {
            client_request_id: "video-fixture-002",
            model: "seedande-2.0",
            first_frame: "mock://media/first-frame",
            last_frame: "mock://media/last-frame",
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        body: {
          client_request_id: "video-fixture-002",
          model: "seedande-2.0",
          inputs: {
            first_frame: "mock://media/first-frame",
            last_frame: "mock://media/last-frame",
          },
        },
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "videos.generate",
        stage: "request",
        script: mediaScript ?? "",
        sample: {
          query: {},
          body: {
            client_request_id: "video-fixture-003",
            model: "seedande-2.0-fast",
            reference_images: references,
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        body: {
          client_request_id: "video-fixture-003",
          model: "seedande-2.0-fast",
          inputs: { reference_images: references },
        },
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "videos.generate",
        stage: "request",
        script: mediaScript ?? "",
        sample: {
          query: {},
          body: {
            first_frame: "mock://media/first-frame",
            reference_images: ["mock://media/reference-1"],
          },
        },
      })
    ).rejects.toMatchObject({ code: "validation_error" });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "videos.generate",
        stage: "response",
        script: submitResponseScript ?? "",
        sample: {
          statusCode: 202,
          headers: { "content-type": "application/json" },
          body: { job_id: "video-job-1" },
        },
      })
    ).resolves.toEqual({
      preview: {
        status: "processing",
        taskId: "video-job-1",
        progress: 0,
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "videos.query",
        stage: "request",
        script: queryRequestScript ?? "",
        sample: { query: { taskId: "video-job-1" } },
      })
    ).resolves.toEqual({
      preview: {
        query: { taskId: "video-job-1", api_version: "2026-08-01" },
      },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "videos.query",
        stage: "response",
        script: queryResponseScript ?? "",
        sample: {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: { state: "processing", progress: 55 },
        },
      })
    ).resolves.toEqual({
      preview: { status: "processing", progress: 55 },
    });

    await expect(
      executeApiUpstreamAdapterTestBinding({
        operation: "videos.query",
        stage: "response",
        script: queryResponseScript ?? "",
        sample: {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: {
            state: "completed",
            output: {
              video_url: "https://cdn.example.test/video-result.mp4",
            },
          },
        },
      })
    ).resolves.toEqual({
      preview: {
        status: "completed",
        outputs: [
          {
            kind: "video",
            url: "https://cdn.example.test/video-result.mp4",
          },
        ],
      },
    });
  });
});
