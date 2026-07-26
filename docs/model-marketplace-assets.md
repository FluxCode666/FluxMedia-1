# 模型广场资产来源与许可

本文记录模型广场默认封面和品牌兼容标识的来源、生成方式、许可与完整性信息。记录日期为
2026-07-26。

## 默认封面

`default-image.webp` 与 `default-video.webp` 均为 FluxMedia 项目原创资产，没有使用生成式
图片服务、第三方图片、字体、文字、商标或外部 URL。构图由项目内确定性 SVG 几何组成，
使用仓库现有 Sharp 0.35.2 直接光栅化为 1200×800、3:2 WebP；编码参数为 quality 82、
effort 6，并且不保留输入元数据。

- `default-image.webp`：暖纸色背景、抽象光晕、弧形笔触与层叠取景框，SHA-256 为
  `2f91f3f9d4e14bf4f3a177fabc4d3e7278c0c0277d6b4686e3dbeee36f1fc0c7`。
- `default-video.webp`：暖纸色背景、抽象光晕、流动轨道与通用播放几何，SHA-256 为
  `0db152dce58958264a9611e5465c39a1053a03881767c5d78fa50279720a06e1`。

版权归 FluxMedia 项目贡献者所有，随本仓库按 `AGPL-3.0-only` 许可分发。

## 品牌兼容标识

OpenAI、Google、Kling 与 xAI 图标取自
[`@lobehub/icons-static-svg@1.94.0`](https://www.npmjs.com/package/@lobehub/icons-static-svg/v/1.94.0)
的对应 `icons/*.svg`。该包来自
[`lobehub/lobe-icons`](https://github.com/lobehub/lobe-icons)，以 MIT 许可发布；本项目于
2026-07-26 获取固定版本，npm tarball SHA-1 为
`2ceb97a0ba59cf1065c2db756af1964f5dfb88de`。纳入仓库时只移除了运行时尺寸、内联 style
和 title，补充静态可访问性属性并格式化 path，不添加脚本、事件、外链或第三方依赖。

厂商名称和图形商标的权利仍归相应权利人所有；本地收录仅用于指称模型来源，不表示厂商
认可或合作。`generic.svg` 不对应任何厂商，是 FluxMedia 项目原创的四向中性菱形。

| 文件 | 精确来源 | 许可 | 清理后 SHA-256 |
| --- | --- | --- | --- |
| `brands/openai.svg` | `icons/openai.svg` | LobeHub MIT | `33f7e4cdc49952f5e6c9295d20d3afcafcbd0bbd26f229b2c4b5e9078c29aa67` |
| `brands/google.svg` | `icons/google.svg` | LobeHub MIT | `3a9676b09a3a00cf7125b71b6b5c302eda883fbb816efdb8b967ab8baa6932bc` |
| `brands/kling.svg` | `icons/kling.svg` | LobeHub MIT | `df350327cef2f6aa936beae2d8ffda6c55c29b5185fad8bfdaee395f1cb120f2` |
| `brands/xai.svg` | `icons/xai.svg` | LobeHub MIT | `b6d2a6f428c27e7e8969894968072be9f78b98ad574fb0ecaff5310bdc1ca83b` |
| `brands/generic.svg` | FluxMedia 原创四向中性菱形 | `AGPL-3.0-only` | `c0c8831212a69769e0ab10a4e07f309a7cbcf3e0620d06e54ce270bc69f1fed8` |

所有 SVG 只含本地静态 path 几何，不含 script、事件属性、外链、嵌入图片或运行时文字。

### LobeHub MIT 许可声明

以下声明随四个 LobeHub 图标副本一并保留：

```text
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 路径与使用边界

代码只能通过
`apps/web/src/features/model-marketplace/assets.ts` 中的固定映射引用这些资产。未知模型必须
使用 `generic`，不得通过名称猜测并冒用某个厂商品牌。全部资源随 Web 应用本地部署，不
依赖第三方 CDN。
