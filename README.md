# GPU 纹理资源制作与验证工具链

把输入图像生成正确的 mip 链，编码为声明支持的块压缩格式（BC1/BC3），写入自描述的
`.gtex` 资源容器，并由**真实图形接口（WebGPU）加载、采样、回读**验证。颜色纹理
（sRGB 传递函数）与线性数据纹理分别处理；设备不支持压缩格式时显式回退到容器内的
RGBA8 负载，并在界面上明确标注，绝不把回退结果当作压缩格式已成功运行的证据。

## 图形入口（主要交付）

压缩纹理的格式对照、缩放、编码切换、实际采样与误差图都在 Web 页面中完成：

```bash
npm start
# 打开 http://localhost:8080/web/index.html
```

要求支持 WebGPU 且具备 `texture-compression-bc` 特性的浏览器（桌面 Chrome/Edge 113+
等）。页面顶部会显示适配器是否真正通告了 BC 特性。

页面功能：

- **格式对照**：BC1 / BC3 / RGBA8 三种编码实时切换，徽标显示当前是“真实压缩格式上设备”
  还是“回退”。设备未通告 BC 特性，或勾选“强制回退”时，加载的是容器内显式 RGBA8 负载，
  状态显示为 `FALLBACK` 并写入事件日志。
- **可缩放纹理**：1x–16x 最近邻放大，检查块边界与半透明边缘。
- **mip 切换**：滑块选择 mip 等级，页面展示该等级的 CPU 参考解码、GPU 实际采样回读、
  以及由逐纹素差值实际计算的误差热图。
- **实际采样与误差**：误差热图、RGB/alpha PSNR、最大绝对差都由真实回读数据计算；
  GPU 回读与规范参考解码器不一致（max |Δ|>4）时以红色异常提示，且不宣称该格式通过。
- **完整 mip 链**：底部逐格展示每一级，便于比较不同 mip 的解码值。
- **异常提示**：WebGPU 初始化失败、容器校验失败、回读不一致等全部显示在页面事件区。
- **传递函数对照**：选择 `linear-data` 后勾选“对线性纹理套用 sRGB 解释”，可直接观察把线性
  数据错误地经 sRGB 视图采样时暗部被抬亮的差异，事件区同时警告这是错误解释。
- **容器回读表**：表格列出每个负载每个 mip 的逻辑尺寸、块对齐尺寸、blob 偏移与字节数，
  用于核对层/mip 偏移与块边界是否被正确描述。
- **候选搜索检查器**：对当前 mip 重新跑一遍按用途的候选搜索，见下节。可在采样视窗直接
  切回穷举对照；点击画布任意块，沿最差点读出实际解码块、所属 mip 与被剪分支；切换“用途”
  或“边缘约定”都会按用途/约定失效缓存，不复用旧排序；还可在同一块上切换平铺/钳位比较。

## 按用途的候选淘汰（优化器）

块压缩搜索常把所有误差压成一个标量分数，于是“颜色几乎一样、但把镜面高光挪到另一边”或
“mip0 看不出、缩小后漏色”的候选会被当成等价。本工具把三类误差作为**各自独立、可分别
解释**的淘汰条件（`src/bc-optimizer.js` 的 `ELIMINATE`）：

- `colour-error`：块均方色差超过（最优 + 窗口）。
- `normal-highlight-flip` / `normal-angle`：解码法线的平均偏角超阈值，或高光质心跨过块中线。
- `alpha-coverage-loss`：源块某边有覆盖、候选却把该边压成全透明（缩小后与相邻块过滤即漏色）。

两类剪枝分开记账（`PRUNE`）：

- `bound`：**可说明依据的误差下界**。每个纹素到端点线段的投影距离 ≤ 到任一调色板项的距离，
  求和即为总误差的下界；超出颜色窗口的端点对直接跳过，**不会错过可接受解**。
- `budget`：每块评估的端点对数上限。可能错过可接受解，因此会对被预算剪掉的端点对做审计，
  在报告里给出“相对穷举错过的可接受解”。

用途、边缘约定、源纹素都参与缓存键（`src/bc-cache.js`），所以**颜色图切为法线图时不会复用
颜色期的排序**；显式 `invalidatePurpose` / `invalidateEdgeMode` 进一步给出可验证的失效边界。

### 两个对抗性夹具（`src/bc-fixtures.js`）

- `normal-flip`：均方色差极小（MSE≈6.3/65025≈0.01%）却把高光质心从 x=2.51 挪到 x=1.26，
  被 `normal-highlight-flip` 淘汰；优化器改选颜色略差但高光仍在正确一侧的端点对。
- `edge-leak`：可见内部完全一致（mip0 色差相等），但右边缘 alpha=0 的概率下藏着不同 RGB。
  最近采样看不到；缩小后与相邻不透明块做直通 alpha 过滤时，一个候选的漏色（fringe）显著
  大于另一个——即“等误差候选在相邻纹理参与过滤后不再等价”。

### 报告与回读

`node cli/gtex-cli.js optimize <texture> [...]` 打印：节约的候选评估次数（相对穷举的百分比）、
最差块的实际解码块与 mip、被 bound/budget 剪掉的分支及理由、各淘汰原因计数与示例，以及
**在已导出块上的回读**——对被预算错过的候选重新打包解码，给出它真正造成的法线偏角 / 透明度 /
色差，而不是只看候选元数据。

```bash
node cli/gtex-cli.js optimize high-freq --purpose=normal --hv=0.902,0.3472,0.2567 --exponent=256
node cli/gtex-cli.js optimize high-freq --budget=20          # 强制预算剪枝并审计错失解
node cli/gtex-cli.js optimize soft-blob --edge=tile          # 平铺 vs 钳位
node cli/gtex-cli.js optimize normal-flip --exhaustive       # 展示高光翻转被淘汰
node cli/gtex-cli.js optimize edge-leak --format=bc3         # 展示缩小后才出现的漏色
```

## 命令行（仅辅助制作与检查）

CLI 负责准备资源文件与做 CPU 侧结构/质量检查，不声明任何设备能力：

```bash
npm run make-assets   # 生成测试 PNG（assets/*.png）
npm run pack          # 等价于 pack-all：生成 assets/*.gtex 并打印逐级 PSNR
npm run verify        # 容器结构校验（偏移、块边界、mip 几何、blob 重叠）
npm test              # CPU 回归测试（32 项）
```

也可打包任意 PNG：

```bash
node cli/gtex-cli.js pack input.png name srgb    # 颜色纹理
node cli/gtex-cli.js pack data.png  name linear  # 线性数据纹理
```

## 资源与加载程序

- `assets/*.gtex`：真实资源文件（含 BC1、BC3、RGBA8 三套负载与完整 mip 表）。
- `web/gpu-texture.js`：真实加载程序，按容器描述创建 WebGPU 纹理并逐 mip 上传/回读。
- `src/`：与运行时无关的核心库（PNG、BC 编解码、mip、容器、颜色空间）。

## `.gtex` 容器布局

全部小端，偏移为文件绝对偏移：

| 区域 | 内容 |
| --- | --- |
| Header 32B | magic `GTEX`、版本、flags（bit0=sRGB）、逻辑宽高、块对齐宽高、mip 数、负载数 |
| Payload 表 | 每项 24B：fourcc、mip 数、首 blob 偏移、总大小 |
| Mip 表 | 每负载每 mip 一项 32B：逻辑宽高、blob 偏移/大小、块对齐宽高 |
| 数据 blob | BC1=8B/块、BC3=16B/块、RGBA8=块对齐宽高×4 |

非整块尺寸（如 33x27）按 4 像素块向上补齐（36x28），边缘用边缘纹素复制填充；逻辑尺寸
单独存储，渲染时裁剪补齐纹素。`verify` 与页面加载前都会校验：mip 几何是否逐级减半、
padding 是否块对齐、blob 大小是否与块数匹配、偏移是否越界或重叠。

## 关键正确性设计

- **透明边缘不产生黑边**：下采样在预乘 alpha 空间做 2x2 盒式滤波；先做颜色扩散（bleed）
  把相邻不透明颜色蔓延到全透明纹素的 RGB（alpha 保持 0）。`downsample2x` 与
  `bleedTransparent` 有专门回归测试。
- **BC1 的 1-bit alpha 不滥用**：仅当块内 alpha 呈二值镂空（cutout）时启用 punch-through；
  软 alpha 块使用 4 色模式，半透明交给 BC3，避免把羽化边缘压成黑色。
- **传递函数分离**：sRGB 纹理用 `*-srgb` 视图格式，由硬件在采样时做传递函数；线性数据
  纹理用普通 `*unorm` 视图，不套用 sRGB。容器 flag 记录该区别。
- **质量不只看压缩率**：报告逐 mip 的 RGB/alpha PSNR，且 RGB 误差只在有覆盖的纹素上统计
  （alpha=0 下的 RGB 不参与混合，不应计入质量）。
- **不盲信驱动**：页面用规范参考解码器（`src/bc.js`）在 CPU 侧解码同一 blob，与 GPU 回读
  逐纹素比对；同时只有适配器通告 `texture-compression-bc` 才创建压缩纹理，否则回退并标注。

## 测试纹理

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `soft-blob` | 33x27（非整块） | 半透明羽化边缘、透明黑边回归、块边界 padding |
| `high-freq` | 50x38（非整块） | 棋盘+正弦高频图案，检验各级 mip 走样与误差 |
| `linear-data` | 32x32（整块） | 线性数据纹理，传递函数与颜色纹理分别处理 |

## 测试

```bash
npm test
```

覆盖：PNG 往返、BC1/BC3 块编解码、cutout 与软 alpha 行为、预乘下采样、bleed、mip 几何、
容器尺寸/偏移/损坏检测、sRGB 传递函数，以及优化器：独立淘汰条件、可说明下界不改变结果、
预算剪枝审计、按用途缓存失效（颜色→法线）、平铺/钳位差异、高光翻转夹具、缩小后才可见的
边缘漏色夹具、BC3 色彩/alpha 分离与回读、最差点读数与节约算量。

## 环境限制说明

本仓库的 CPU 侧（编码器、容器、参考解码、校验、16 项回归）可在 Node 中完整运行并已通过。
GPU 侧的真实加载/采样/回读需要带 WebGPU 与 BC 特性的浏览器；当前构建环境没有浏览器/GPU，
因此该部分需按上面的“图形入口”在本机浏览器中执行验证，代码不使用任何模拟或软件替代来
冒充设备结果。
