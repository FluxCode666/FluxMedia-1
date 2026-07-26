# Adobe 来源 api 后端（adobe-sourced api backend）

状态：设计定稿，分阶段实现中。
关联代码：`apps/web/src/features/image-backend-pool/service.ts`、
`apps/web/src/features/image-generation/service.ts`、
`packages/database/src/schema.ts`、`packages/database/drizzle/0045_api_adobe_sourced.sql`。

## 1. 目标与背景

部分上游提供商对外是 **OpenAI / gpt 格式**的图像 API，但其**实际来源是 Adobe**。
我们希望把这类 `image_backend_api` 后端：

- **按 Adobe 口径计费**（与 Adobe 伪账号同一倍率链）；
- **纳入 Adobe（firefly）调度**，能承接 firefly 工作负载，与真 Adobe 后端同池竞争。

而调用形态仍是普通 OpenAI 图像 API（`image_backend_api`，走 gpt 请求/响应），
不改变其传输与鉴权方式。

## 2. 数据模型（迁移 0045）

`image_backend_api` 新增两列（手写幂等迁移 + `_journal` 已登记）：

| 列 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `adobe_sourced` | boolean | false | 该 api 后端上游是否为 Adobe。开启后启用下面的计费与调度特例。 |
| `billing_multiplier` | numeric | 1 | 计费倍率，语义同 `image_backend_adobe.billing_multiplier`；**仅当 `adobe_sourced` 为真时生效**。 |

`image_backend_api.model`（已存在）继续用作出站模型名（见 §5 的可选覆盖）。

## 3. 计费（复用 Adobe 伪账号倍率链）

全站图像/视频计费只认一个值 `config.backend.billingMultiplier`
（`operations.ts` / `video-operations.ts` 都读它）。Adobe 伪账号的口径是
`组倍率 × 后端倍率`（`service.ts` 的 pool-adobe 分支）。

本方案让 pool-api 分支在 **`adobeSourced` 为真时**采用同一公式：

```
config.backend.billingMultiplier =
  adobeSourced ? (组倍率 × 本后端 billingMultiplier) : 组倍率
```

因此「Adobe 来源」api 的价格与对应 Adobe 伪账号**一分不差**，且复用既有的
扣费 / 退款 / 明细管线（幂等键不变），无需新增计费逻辑。视频不在本期范围（§8）。

### 3.1 两级倍率（务必看懂，避免价格混乱）

计费倍率分**两级**，各管一层，最终**相乘**（默认都为 1，相乘仍为 1）：

- **组倍率（group）**：挂在**分组** `image_backend_group` 上
  （`getGroupBillingMultiplier(组.metadata)`）。改它会影响该组下**所有**后端。
  用于给"一整组"统一定价。
- **成员倍率（member）**：挂在**单个后端**行上
  （`image_backend_adobe.billing_multiplier`，本方案给 `image_backend_api` 也加同名列）。
  只影响**这一个后端**。用于精调单个上游/账号的价格。

> 注意：一个后端可同时挂多个组；计费用的是**本次请求实际命中的那个组**的倍率
> （`getEffectiveBillingMultiplierForSelectedGroup`），不是它挂的所有组。

最终：

```
实扣积分 = ceil2(基础价 × 命中组的组倍率 × 该后端成员倍率)
          └────────── config.backend.billingMultiplier ──────────┘
```

基础价由 size/质量等既有定价得出；本方案只动"倍率"那一段。

### 3.2 倍率算例（文档与控制台共用，基础价以 100 积分示意）

| 场景 | 基础价 | 组倍率 | 成员倍率 | 合成倍率 | 实扣 |
|---|---|---|---|---|---|
| 普通 api（默认） | 100 | 1 | —（恒 1） | 1 | 100 |
| 普通 api，组 ×1.5 | 100 | 1.5 | —（恒 1） | 1.5 | 150 |
| 真 Adobe 伪账号，成员 ×2 | 100 | 1 | 2 | 2 | 200 |
| 真 Adobe，组 ×1.2 + 成员 ×2 | 100 | 1.2 | 2 | 2.4 | 240 |
| **Adobe 来源 api**（adobeSourced，组 ×1.2 + 成员 ×2） | 100 | 1.2 | 2 | 2.4 | 240 |
| Adobe 来源 api 但**开关关**（成员倍率被忽略） | 100 | 1.2 | 2（忽略） | 1.2 | 120 |

要点：**只有** `adobeSourced=true` 的 api 才吃成员倍率；关掉就退回"只吃组倍率"，
和普通 api 一致。控制台在后端编辑处展示同款算例，管理员调倍率时即时对照。

### 3.3 真实链路算例（含模型倍率，与控制台同口径）

实际还有第三个乘数：**模型倍率**（`IMAGE_MODEL_MULTIPLIERS` 系统设置，按家族，
如线上 `nano-banana-pro = 1.5`）。完整链路（与 dashboard「含分组倍率示例」同口径、
**嵌套 ceil2**）：

```
单张实扣 = 向上保留两位( 向上保留两位(基础价 + 审核附加) × 模型倍率 × 命中组倍率 × 成员倍率 )
```

**算例：nano-banana-pro · 1024×1024**（基础价 6 + 审核附加 0.04；模型 ×1.5；示例组 ×1.2）

| 成员倍率 | 算式 | 实扣 |
|---|---|---|
| ×1（开关关 = 普通 api 等效） | ceil2(ceil2(6.04) × 1.5 × 1.2 × 1) | 10.88 积分/张 |
| ×2 | ceil2(ceil2(6.04) × 1.5 × 1.2 × 2) | 21.75 积分/张 |

对照：同尺寸 gpt-image（模型 ×1，普通 api、组 ×1.5）= ceil2(ceil2(6.04) × 1.5) =
9.06 积分/张。可见 nano-banana-pro 因模型 ×1.5、再叠 Adobe 成员倍率，"乘数更多、更贵"。
控制台 api 后端编辑处的算例随成员倍率输入**实时更新**。

## 4. 调度（纳入 firefly 候选）

候选构建时，`fireflyOnly`（= `force_firefly` 或请求模型为 `firefly-*`）原本会排除
所有普通 api、只留 Adobe。本方案放行「Adobe 来源」api：

```
api 成员参与候选的条件： (!fireflyOnly || row.adobeSourced) && (其余原有过滤)
```

即「Adobe 来源」api 与真 Adobe 后端**同池按 priority 竞争**。管理员把它优先级调低即天然成为兜底。

## 5. 反向转换（firefly-* → gpt）

当**被选中的后端是「Adobe 来源」api** 且**请求模型以 `firefly-` 开头**时，在 api 派发前改写出站请求：

- **出站 model**：从 firefly id 截取家族名，复用现有
  `pickExplicitAdobeImageFamily`（按最长前缀从 `firefly-` 后截，避免 `nano-banana`
  误吞 `nano-banana-pro`/`nano-banana2`）。截得的家族即 gpt 侧模型名：
  `gpt-image-2` / `gpt-image-1.5` / `nano-banana` / `nano-banana2` / `nano-banana-pro`。
  - **可选覆盖**：若该后端 `image_backend_api.model` 非空，则用它（兼容个别 provider 用不同模型名）；否则用截取值。
  - 截不出家族（未知 firefly id）→ 该后端无法服务此请求，按错误处理，调度回退到下一候选 / 真 Adobe。
- **出站 size**：
  - 全量 id（`firefly-<家族>-<res>-<ratio>`）：由 `<res>/<ratio>` 推像素，复用
    `sizeFromRatio`（非 gpt-image 家族）/ `gptImagePixelsFromRatio`（gpt-image 家族），转成 OpenAI `size`（`"WxH"`）。
  - 族级 id（`firefly-gpt-image-2`，无 res/ratio）：沿用请求自带 `size`。
- **绕开校验**：现有 `getModel` 只认 `gpt-image-*`，截出的 `nano-banana-*` 会被拒；
  本路径直接用截得的家族名发请求，不经 `getModel` 的 gpt-image-only 校验。
- 触发条件之外（普通 gpt 请求，含 `force_firefly` 路由的 gpt-image）：**不做任何转换**，按普通 api 处理。
- 需把 `adobeSourced` 透传到 `config.backend`（pool-api）以便派发层判定。

边界小结：反向转换**只在 `pool-api + adobeSourced + 请求模型 firefly-*`** 三条件同时满足时触发。

## 6. 后台

`image_backend_api` 的创建/编辑表单新增：
- `adobeSourced` 开关；
- `billingMultiplier` 数值（仅在 `adobeSourced` 开启时有意义，UI 可联动禁用）。

create/update service 持久化这两列（列有 DB 默认，旧数据/旧调用不受影响）。

## 7. 测试（财务改动必须有测）

- **计费**：`adobeSourced=true` 时 `config.backend.billingMultiplier = 组×成员`；
  `adobeSourced=false` 时仅组倍率（成员倍率被忽略）。
- **调度候选**：`adobeSourced` api 在 `fireflyOnly` 下进入候选；普通 api 不进。
- **反向映射**：`firefly-gpt-image-2-2k-16x9` → model `gpt-image-2` + 由 `2k/16x9` 推出的 size；
  族级 `firefly-nano-banana-pro` → model `nano-banana-pro` + 用请求 size；未知 id → 不可服务。
- 纯函数（家族截取、size 推导）抽到 DB-free 模块单测。

## 8. 不在本期范围

- **视频**：firefly-* 视频模型仍只走真 Adobe；`billingMultiplier` 的视频口径已存在，
  若将来该类 api 真出视频会自动生效，但本期不接视频路径。
- 多 provider 不同模型名的批量映射表（用 `model` 单字段覆盖即可覆盖现状）。

## 9. 落地顺序

1. 迁移 0045 + schema 两列。（已完成）
2. 计费接线：api 成员带字段；config 仅 `adobeSourced` 时套成员倍率。（已完成）
3. 调度：放行 `adobeSourced` api 进 firefly 候选。（已完成）
4. 反向转换：`config.backend` 透传 `adobeSourced`；派发前改写 model/size；绕开 gpt-image-only 校验。
5. 后台表单 + create/update。
6. 测试（计费 / 候选 / 反向映射）。
7. 本文档随实现校订；质量门（typecheck/lint/test）全绿后蓝绿部署。
